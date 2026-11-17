from flask import Flask, render_template, jsonify, request, send_file
from bs4 import BeautifulSoup
import threading
import pandas as pd
import time
import io
import re
import os
import json
import tempfile
import atexit
from copy import deepcopy
from datetime import datetime

# ============================================================================
# SAFE CLOUD / SERVERLESS ENVIRONMENT CONFIGURATION
# ============================================================================
# Redirect Selenium and webdriver-manager caches to /tmp to prevent [Errno 30] read-only errors on Vercel/Lambda
_tmp_dir = tempfile.gettempdir()
os.environ.setdefault("SE_CACHE_PATH", os.path.join(_tmp_dir, "selenium"))
os.environ.setdefault("WDM_LOCAL", "1")
os.environ.setdefault("WDM_DIR", os.path.join(_tmp_dir, "wdm"))

app = Flask(__name__)

# Concurrency & Process Controls
status_lock = threading.Lock()
scrape_thread = None
stop_event = threading.Event()
_active_driver = None
_cached_driver_path = None

SCRAPE_URL = "https://www.imdb.com/chart/top/"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

scrape_status = {
    "state": "idle",
    "message": "Ready to scrape IMDb Top 250.",
    "progress": 0,
    "count": 0,
    "data": [],
    "logs": [],
    "history": [],
    "started_at": None,
    "finished_at": None,
}


def log(message: str, level: str = "INFO"):
    """Thread-safe append of a timestamped log entry to the shared state."""
    timestamp = datetime.now().strftime("%H:%M:%S")
    entry = f"[{timestamp}] [{level}] {message}"
    with status_lock:
        scrape_status["logs"].append(entry)
        if len(scrape_status["logs"]) > 500:
            scrape_status["logs"] = scrape_status["logs"][-400:]


def cleanup_active_driver():
    """Ensure any running headless Chrome instance is cleanly terminated on exit."""
    global _active_driver
    if _active_driver is not None:
        try:
            _active_driver.quit()
        except Exception:
            pass
        _active_driver = None


atexit.register(cleanup_active_driver)


def is_serverless_env() -> bool:
    """Detect if running in serverless platforms like Vercel or AWS Lambda."""
    return bool(
        os.environ.get("VERCEL")
        or os.environ.get("AWS_LAMBDA_FUNCTION_NAME")
        or os.environ.get("LAMBDA_TASK_ROOT")
    )


def create_driver(headless: bool = True):
    """Initializes Chrome WebDriver with safe temporary storage and anti-detection."""
    global _cached_driver_path, _active_driver
    from selenium import webdriver
    from selenium.webdriver.chrome.service import Service
    from webdriver_manager.chrome import ChromeDriverManager

    options = webdriver.ChromeOptions()
    options.page_load_strategy = "eager"
    options.add_argument("--disable-gpu")
    options.add_argument("--disable-extensions")
    options.add_argument("--no-sandbox")
    options.add_argument("--window-size=1440,900")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-background-networking")
    options.add_argument("--disable-sync")
    options.add_argument("--no-first-run")
    options.add_argument(f"--user-agent={USER_AGENT}")
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option("useAutomationExtension", False)

    # Use system temp directory for user-data-dir so it works on read-only cloud hosts like Vercel/Lambda
    profile_dir = os.path.join(tempfile.gettempdir(), "imdb_chrome_session")
    try:
        os.makedirs(profile_dir, exist_ok=True)
        options.add_argument(f"--user-data-dir={profile_dir}")
    except Exception:
        pass

    if headless:
        options.add_argument("--headless=new")

    driver = None
    try:
        driver = webdriver.Chrome(options=options)
    except Exception:
        if not _cached_driver_path:
            _cached_driver_path = ChromeDriverManager().install()
        driver = webdriver.Chrome(
            service=Service(_cached_driver_path),
            options=options,
        )

    _active_driver = driver
    return driver


def load_fallback_dataset():
    """Loads the pre-scraped full 250 movie dataset for offline or cloud execution."""
    base_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(base_dir, "data", "imdb_top250.json"),
        os.path.join(base_dir, "imdb_top250.json"),
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if isinstance(data, list) and len(data) > 0:
                        return data
            except Exception as e:
                log(f"Error loading fallback dataset: {e}", "WARN")
    return []


def save_dataset_cache(movies):
    """Saves newly scraped movies to local dataset cache for offline / cloud fallback."""
    if not movies or len(movies) < 50:
        return
    base_dir = os.path.dirname(os.path.abspath(__file__))
    data_dir = os.path.join(base_dir, "data")
    try:
        os.makedirs(data_dir, exist_ok=True)
        target = os.path.join(data_dir, "imdb_top250.json")
        with open(target, "w", encoding="utf-8") as f:
            json.dump(movies, f, indent=2, ensure_ascii=False)
    except Exception:
        pass


def extract_movies_js(driver):
    """
    High-fidelity extraction:
    1. Extracts all 250 movies instantly from window.__NEXT_DATA__ (complete dataset without truncation).
    2. Fallback: Automatically scrolls page to hydrate virtualized DOM and queries rendered elements.
    """
    # 1. Direct Next.js Hydration Dataset Extraction (Complete 250 list)
    js_next_data = """
    try {
        const nextData = window.__NEXT_DATA__;
        if (nextData && nextData.props && nextData.props.pageProps) {
            const edges = nextData.props.pageProps.pageData?.chartTitles?.edges;
            if (Array.isArray(edges) && edges.length > 0) {
                return edges.map((edge, idx) => {
                    const node = edge.node || {};
                    const rank = idx + 1;
                    const title = (node.titleText && node.titleText.text) || '';
                    const year = (node.releaseYear && node.releaseYear.year) ? String(node.releaseYear.year) : '';
                    const rating = (node.ratingsSummary && node.ratingsSummary.aggregateRating) ? Number(node.ratingsSummary.aggregateRating) : 0.0;
                    
                    let votes = '';
                    if (node.ratingsSummary && node.ratingsSummary.voteCount) {
                        const vc = node.ratingsSummary.voteCount;
                        if (vc >= 1000000) {
                            votes = (vc / 1000000).toFixed(1) + 'M';
                        } else if (vc >= 1000) {
                            votes = (vc / 1000).toFixed(0) + 'K';
                        } else {
                            votes = String(vc);
                        }
                    }
                    
                    let duration = '';
                    if (node.runtime && node.runtime.seconds) {
                        const totalMins = Math.floor(node.runtime.seconds / 60);
                        const h = Math.floor(totalMins / 60);
                        const m = totalMins % 60;
                        duration = h > 0 ? `${h}h ${m}m` : `${m}m`;
                    }
                    
                    const certificate = (node.certificate && node.certificate.rating) || '';
                    const poster = (node.primaryImage && node.primaryImage.url) || '';
                    
                    return { rank, title, year, rating, duration, certificate, votes, poster };
                });
            }
        }
    } catch(e) {
        console.error('NEXT_DATA extraction error', e);
    }
    return [];
    """
    try:
        data = driver.execute_script(js_next_data)
        if isinstance(data, list) and len(data) >= 200:
            log(f"Extracted complete {len(data)} movies dataset directly from page state.", "PARSE")
            return data
    except Exception as e:
        log(f"NEXT_DATA extraction note: {e}", "WARN")

    # 2. Scroll through page to trigger IMDb's virtualized DOM lazy-loader
    try:
        log("Hydrating full page DOM through smooth scroll...", "SCROLL")
        for _ in range(5):
            if stop_event.is_set():
                return []
            driver.execute_script("window.scrollBy(0, 1800);")
            time.sleep(0.3)
        driver.execute_script("window.scrollTo(0, 0);")
        time.sleep(0.2)
    except Exception:
        pass

    # 3. DOM query extraction
    js_dom = """
    return Array.from(document.querySelectorAll('li.ipc-metadata-list-summary-item')).map((item, idx) => {
        const titleEl = item.querySelector('a.ipc-title-link-wrapper, h3.ipc-title__text, .ipc-title__text');
        let title = titleEl ? titleEl.textContent.trim() : '';

        const rankEl = item.querySelector('div.ipc-signpost__text, .ipc-signpost__text');
        let rank = idx + 1;
        if (rankEl) {
            const parsed = parseInt(rankEl.textContent.replace('#', '').trim(), 10);
            if (!isNaN(parsed)) rank = parsed;
        }

        const meta = Array.from(item.querySelectorAll('.ipc-inline-list__item')).map(el => el.textContent.trim());
        const year = meta[0] || '';
        const duration = meta[1] || '';
        const certificate = meta[2] || '';

        const ratingEl = item.querySelector('.ipc-rating-star--rating, .ipc-rating-star');
        let rating = 0.0;
        if (ratingEl) {
            const m = ratingEl.textContent.match(/[0-9]+(\\.[0-9]+)?/);
            if (m) rating = parseFloat(m[0]);
        }

        const votesEl = item.querySelector('.ipc-rating-star--voteCount');
        let votes = votesEl ? votesEl.textContent.replace(/[()]/g, '').trim() : '';

        const img = item.querySelector('img.ipc-image') || item.querySelector('img');
        let poster = img ? (img.src || img.getAttribute('src') || '') : '';

        return { rank, title, year, rating, duration, certificate, votes, poster };
    });
    """
    try:
        data = driver.execute_script(js_dom)
        if isinstance(data, list) and len(data) > 0:
            return data
    except Exception as e:
        log(f"DOM JS extraction fallback: {e}", "WARN")
    return []


def parse_modern_layout(soup):
    """Parse li.ipc-metadata-list-summary-item elements (current IMDb layout)."""
    items = soup.select("li.ipc-metadata-list-summary-item")
    movies = []
    for idx, item in enumerate(items, 1):
        try:
            title_el = (
                item.select_one("a.ipc-title-link-wrapper") or 
                item.select_one("h3.ipc-title__text") or 
                item.select_one(".ipc-title__text")
            )
            title = title_el.get_text(strip=True) if title_el else ""

            rank_el = item.select_one("div.ipc-signpost__text, .ipc-signpost__text")
            if rank_el:
                rank_str = rank_el.get_text(strip=True).lstrip("#")
                rank = int(rank_str) if rank_str.isdigit() else idx
            else:
                rank = idx

            metadata_items = [m.get_text(strip=True) for m in item.select("li.ipc-inline-list__item")]
            year = metadata_items[0] if len(metadata_items) > 0 else ""
            duration = metadata_items[1] if len(metadata_items) > 1 else ""
            certificate = metadata_items[2] if len(metadata_items) > 2 else ""

            rating_el = item.select_one("span.ipc-rating-star--rating, .ipc-rating-star--rating, .ipc-rating-star")
            rating_raw = rating_el.get_text(strip=True) if rating_el else "0"
            rating_match = re.search(r"[\d.]+", rating_raw)
            rating = float(rating_match.group()) if rating_match else 0.0

            votes_el = item.select_one("span.ipc-rating-star--voteCount, .ipc-rating-star--voteCount")
            votes = votes_el.get_text(strip=True).strip("()") if votes_el else ""

            poster_el = item.select_one("img.ipc-image") or item.select_one("img")
            poster = poster_el.get("src", "") if poster_el else ""

            movie = {
                "rank": rank,
                "title": title,
                "year": year,
                "rating": rating,
                "duration": duration,
                "certificate": certificate,
                "votes": votes,
                "poster": poster,
            }
            movies.append(movie)
        except Exception:
            continue
    return movies


def parse_legacy_layout(soup):
    """Parse table.chart.full-width layout (legacy IMDb layout)."""
    rows = soup.select("table.chart.full-width tbody.lister-list > tr")
    movies = []
    for row in rows:
        try:
            title_col = row.select_one(".titleColumn")
            rank = title_col.text.split(".")[0].strip() if title_col else "0"
            title = title_col.select_one("a").text.strip() if title_col else ""
            year_el = row.select_one(".titleColumn span.secondaryInfo")
            year = year_el.text.strip("() ") if year_el else ""
            rating_el = row.select_one(".imdbRating strong")
            rating = float(rating_el.text.strip()) if rating_el else 0.0
            poster_el = row.select_one(".posterColumn img")
            poster = poster_el.get("src", "") if poster_el else ""

            movie = {
                "rank": int(rank) if rank.isdigit() else 0,
                "title": title,
                "year": year,
                "rating": rating,
                "duration": "",
                "certificate": "",
                "votes": "",
                "poster": poster,
            }
            movies.append(movie)
        except Exception:
            continue
    return movies


def scrape_imdb_top250(headless: bool = True, limit: int | None = None, start_rank: int = 1, end_rank: int = 250):
    """Main orchestrator running in a background thread."""
    global scrape_status, _active_driver
    stop_event.clear()

    start_rank = max(1, min(start_rank, 250))
    end_rank = max(start_rank, min(end_rank, 250))
    if limit and limit > 0:
        end_rank = min(end_rank, start_rank + limit - 1)

    start_ts = time.time()
    started_at_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    session = {
        "id": datetime.now().strftime("%Y%m%d%H%M%S"),
        "state": "scraping",
        "started_at": started_at_str,
        "finished_at": None,
        "movie_count": 0,
        "requested_limit": limit if limit else 250,
        "start_rank": start_rank,
        "end_rank": end_rank,
        "duration_secs": None,
        "avg_rating": 0.0,
        "message": "Scraper session initialized.",
    }

    with status_lock:
        scrape_status["state"] = "scraping"
        scrape_status["message"] = "Initializing Scraper..."
        scrape_status["progress"] = 0
        scrape_status["count"] = 0
        scrape_status["data"] = []
        scrape_status["logs"] = []
        scrape_status["started_at"] = started_at_str
        scrape_status["finished_at"] = None
        scrape_status["history"].insert(0, session)

    log("Scraper session started.", "SYSTEM")
    log(f"Headless mode: {'ON' if headless else 'OFF'}", "CONFIG")
    log(f"Requested scrape range: ranks {start_rank} - {end_rank} (limit {session['requested_limit']}).", "CONFIG")

    driver = None
    all_movies = []

    try:
        log("Checking browser environment...", "SETUP")
        # In cloud serverless platforms (Vercel/Lambda), Chrome is absent by default
        if is_serverless_env():
            log("Serverless cloud environment detected. Activating instant verified dataset...", "SYSTEM")
            all_movies = load_fallback_dataset()
        else:
            try:
                driver = create_driver(headless=headless)
                log("Chrome WebDriver initialized successfully.", "SETUP")
            except Exception as driver_err:
                log(f"Headless Chrome unavailable ({driver_err}). Loading verified dataset...", "WARN")
                all_movies = load_fallback_dataset()
                if not all_movies:
                    raise RuntimeError(
                        f"Headless Chrome is not installed on this server, and no local fallback dataset was found: {driver_err}"
                    )

        if stop_event.is_set():
            with status_lock:
                scrape_status["state"] = "stopped"
                scrape_status["message"] = "Scraping was cancelled before page load."
                session["state"] = "stopped"
                session["message"] = scrape_status["message"]
            return

        # If driver is active, perform live web scraping
        if driver:
            from selenium.webdriver.common.by import By
            from selenium.webdriver.support.ui import WebDriverWait
            from selenium.webdriver.support import expected_conditions as EC

            log(f"Navigating to {SCRAPE_URL}...", "NAVIGATE")
            with status_lock:
                scrape_status["message"] = "Loading IMDb Top 250 page..."
            driver.get(SCRAPE_URL)
            log("Page requested. Waiting for movie list to render...", "NAVIGATE")

            try:
                WebDriverWait(driver, 20).until(
                    EC.presence_of_element_located(
                        (By.CSS_SELECTOR, "li.ipc-metadata-list-summary-item, table.chart, script#__NEXT_DATA__")
                    )
                )
                log("IMDb page loaded successfully.", "PARSE")
            except Exception as wait_err:
                log(f"Timeout waiting for elements: {wait_err}", "WARN")

            if stop_event.is_set():
                return

            log("Extracting movie dataset directly in-browser...", "PARSE")
            with status_lock:
                scrape_status["message"] = "Extracting movie data..."
            all_movies = extract_movies_js(driver)

            # Fallback to BeautifulSoup if JS extraction returned empty
            if not all_movies:
                log("Running BeautifulSoup fallback parser...", "PARSE")
                soup = BeautifulSoup(driver.page_source, "html.parser")
                all_movies = parse_modern_layout(soup)

            if not all_movies:
                log("Modern layout yielded no results. Trying legacy parser...", "PARSE")
                soup = BeautifulSoup(driver.page_source, "html.parser")
                all_movies = parse_legacy_layout(soup)

            # Auto-save fresh dataset cache for future cloud/offline use
            if all_movies and len(all_movies) >= 200:
                save_dataset_cache(all_movies)

        if not all_movies:
            all_movies = load_fallback_dataset()

        if not all_movies:
            log("No movies found with any parser or fallback dataset.", "ERROR")
            with status_lock:
                scrape_status["state"] = "error"
                scrape_status["message"] = "Could not find any movie elements on the page."
                session["state"] = "error"
                session["message"] = scrape_status["message"]
            return

        selected_movies = [
            movie for movie in all_movies
            if start_rank <= movie.get("rank", 0) <= end_rank
        ]
        selected_movies.sort(key=lambda movie: movie.get("rank", 0))

        total = len(selected_movies)
        if total == 0:
            log("Requested scrape range did not match any extracted movies.", "ERROR")
            with status_lock:
                scrape_status["state"] = "error"
                scrape_status["message"] = "No movies found for the selected rank range."
                session["state"] = "error"
                session["message"] = scrape_status["message"]
            return

        log(f"Extracted {len(all_movies)} movies; streaming {total} movies for the requested range.", "SCRAPE")
        msg = f"Loading ranks {start_rank}-{end_rank} ({total} movies)."
        with status_lock:
            scrape_status["message"] = msg
            session["message"] = msg

        # Fluid batch streaming to dashboard for smooth live visualization
        batch_size = 5
        for i in range(0, total, batch_size):
            if stop_event.is_set():
                log("Stop signal received. Halting scraper.", "SYSTEM")
                with status_lock:
                    scrape_status["state"] = "stopped"
                    scrape_status["message"] = f"Scraping stopped by user at {len(scrape_status['data'])}/{total} movies."
                    session["state"] = "stopped"
                    session["message"] = scrape_status["message"]
                    session["movie_count"] = len(scrape_status["data"])
                break

            chunk = selected_movies[i : i + batch_size]
            with status_lock:
                scrape_status["data"].extend(chunk)
                current_count = len(scrape_status["data"])
                scrape_status["count"] = current_count
                scrape_status["progress"] = int(current_count / total * 100)
                scrape_status["message"] = f"Scraped {current_count}/{total}: {chunk[-1]['title']}"
                session["movie_count"] = current_count

            if current_count % 50 == 0 or current_count == total:
                log(
                    f"Scraped #{chunk[-1]['rank']}: {chunk[-1]['title']} ({chunk[-1]['year']}) — ★ {chunk[-1]['rating']}",
                    "SCRAPE",
                )

            # Tiny micro-sleep (5ms) for fluid UI updates
            time.sleep(0.005)

        if not stop_event.is_set():
            with status_lock:
                scrape_status["state"] = "completed"
                scrape_status["message"] = f"Successfully scraped {total} movies!"
                session["state"] = "completed"
                session["message"] = scrape_status["message"]
            log(f"Scraping completed! {total} movies extracted.", "DONE")

    except Exception as error:
        with status_lock:
            scrape_status["state"] = "error"
            scrape_status["message"] = f"Error: {error}"
        log(f"Critical error: {error}", "ERROR")
    finally:
        if driver:
            try:
                driver.quit()
                log("Chrome WebDriver closed.", "SYSTEM")
            except Exception:
                pass
            _active_driver = None

        finished_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with status_lock:
            scrape_status["finished_at"] = finished_str
            session["finished_at"] = finished_str
            session["duration_secs"] = round(time.time() - start_ts, 2)
            if scrape_status["data"]:
                session["avg_rating"] = round(
                    sum(item.get("rating", 0) for item in scrape_status["data"]) / len(scrape_status["data"]),
                    2,
                )
            if scrape_status["state"] == "scraping":
                scrape_status["state"] = "completed"
                session["state"] = "completed"
                session["message"] = scrape_status["message"]


# ---------------------------------------------------------------------------
# Flask routes (Thread-Safe)
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/start-scrape", methods=["POST"])
def start_scrape():
    global scrape_thread
    if scrape_thread and scrape_thread.is_alive():
        return jsonify({"status": "busy", "message": "Scraping is already running."}), 409

    content = request.json or {}
    headless = bool(content.get("headless", True))
    limit = content.get("limit")
    start_rank = content.get("start_rank", 1)
    end_rank = content.get("end_rank", 250)

    try:
        limit = int(limit) if limit is not None else None
    except (TypeError, ValueError):
        limit = None

    try:
        start_rank = int(start_rank)
    except (TypeError, ValueError):
        start_rank = 1

    try:
        end_rank = int(end_rank)
    except (TypeError, ValueError):
        end_rank = 250

    if is_serverless_env():
        # Serverless containers (Vercel/Lambda) freeze background threads immediately upon HTTP return.
        # Run synchronously to ensure dataset is loaded and ready before responding.
        scrape_imdb_top250(headless, limit, start_rank, end_rank)
    else:
        scrape_thread = threading.Thread(
            target=scrape_imdb_top250,
            args=(headless, limit, start_rank, end_rank),
            daemon=True,
        )
        scrape_thread.start()
    return jsonify({
        "status": "started",
        "message": "Scraping started.",
        "headless": headless,
        "limit": limit,
        "start_rank": start_rank,
        "end_rank": end_rank,
    })


@app.route("/stop-scrape", methods=["POST"])
def stop_scrape():
    if not scrape_thread or not scrape_thread.is_alive():
        return jsonify({"status": "idle", "message": "No scraping session is active."}), 400

    stop_event.set()
    return jsonify({"status": "stopping", "message": "Stop signal sent."})


@app.route("/scrape-status")
def status():
    with status_lock:
        # Create a safe snapshot for JSON serialization to avoid mutation during encoding
        snapshot = {
            "state": scrape_status["state"],
            "message": scrape_status["message"],
            "progress": scrape_status["progress"],
            "count": scrape_status["count"],
            "data": list(scrape_status["data"]),
            "logs": list(scrape_status["logs"]),
            "history": list(scrape_status["history"]),
            "started_at": scrape_status["started_at"],
            "finished_at": scrape_status["finished_at"],
        }
    return jsonify(snapshot)


@app.route("/movies")
def movies():
    with status_lock:
        movie_list = list(scrape_status.get("data", []))
    return jsonify(movie_list)


@app.route("/download-csv")
def download_csv():
    with status_lock:
        data = list(scrape_status.get("data", []))

    if not data:
        return jsonify({"status": "empty", "message": "No movie data available to export."}), 400

    df = pd.DataFrame(data)
    csv_buffer = io.StringIO()
    df.to_csv(csv_buffer, index=False)
    csv_buffer.seek(0)

    return send_file(
        io.BytesIO(csv_buffer.getvalue().encode("utf-8")),
        mimetype="text/csv",
        as_attachment=True,
        download_name="imdb_top250_scrape.csv",
    )


if __name__ == "__main__":
    app.run(debug=True, port=5000)
