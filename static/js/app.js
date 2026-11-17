// ============================================================================
// DOM ELEMENTS
// ============================================================================
const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const downloadButton = document.getElementById("downloadButton");
const exportDownloadBtn = document.getElementById("exportDownloadBtn");
const progressBar = document.getElementById("progressBar");
const statusIndicator = document.getElementById("statusIndicator");
const statusMessage = document.getElementById("statusMessage");
const movieCount = document.getElementById("movieCount");
const movieTableBody = document.getElementById("movieTableBody");
const liveCount = document.getElementById("liveCount");
const avgRating = document.getElementById("avgRating");
const progressText = document.getElementById("progressText");
const searchInput = document.getElementById("searchInput");
const ratingFilter = document.getElementById("ratingFilter");
const headlessToggle = document.getElementById("headlessToggle");
const scrapeLimit = document.getElementById("scrapeLimit");
const startRank = document.getElementById("startRank");
const endRank = document.getElementById("endRank");
const metricStatus = document.getElementById("metricStatus");
const movieModal = document.getElementById("movieModal");
const modalClose = document.getElementById("modalClose");
const historyTableBody = document.getElementById("historyTableBody");
const exportRowCount = document.getElementById("exportRowCount");
const exportScrapeStatus = document.getElementById("exportScrapeStatus");
const sortBySelect = document.getElementById("sortBySelect");
const categorySelect = document.getElementById("categorySelect");
const perPageSelect = document.getElementById("perPageSelect");

// ============================================================================
// STATE
// ============================================================================
let movies = [];
let ratingChart = null;
let decadeChart = null;
let pollInterval = null;
let refreshDelay = 2000;
let currentPage = 1;
let itemsPerPage = 15; // User requirement: 15 movies per sort / page by default
let currentSort = "rank-asc";
let currentCategory = "all";

const setPollingRate = (delay) => {
    if (pollInterval) clearInterval(pollInterval);
    refreshDelay = delay;
    pollInterval = setInterval(fetchStatus, delay);
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================
const getOptimizedPosterUrl = (url, width = 200) => {
    if (!url) return "";
    // If it's an Amazon/IMDb CDN image, transform into an optimized fast-loading thumbnail
    if (url.includes("media-amazon.com") && url.includes("._V1_")) {
        const height = Math.round(width * 1.48);
        return url.replace(/\._V1_.*?\.(jpg|jpeg|png)$/i, `._V1_QL75_UX${width}_CR0,1,${width},${height}_.jpg`);
    }
    return url;
};

const formatStatus = (state) => {
    const statusMap = {
        "completed": "Completed",
        "scraping": "Scraping",
        "error": "Error",
        "stopped": "Stopped"
    };
    return statusMap[state] || "Idle";
};

const setStatus = (state, message) => {
    statusIndicator.textContent = formatStatus(state);
    statusMessage.textContent = message;
    metricStatus.textContent = formatStatus(state).toUpperCase();

    const colorMap = {
        "scraping": "rgba(0, 255, 234, 0.14)",
        "completed": "rgba(201, 0, 255, 0.14)",
        "error": "rgba(255, 0, 128, 0.18)",
        "stopped": "rgba(255, 165, 0, 0.14)"
    };
    statusIndicator.style.background = colorMap[state] || "rgba(255, 255, 255, 0.08)";
};

const getMovieCategory = (movie) => {
    const r = parseFloat(movie.rating) || 0;
    const y = parseInt(movie.year, 10) || 0;
    const d = movie.duration || "";

    let totalMinutes = 0;
    const hourMatch = d.match(/(\d+)\s*h/);
    const minMatch = d.match(/(\d+)\s*m/);
    if (hourMatch) totalMinutes += parseInt(hourMatch[1], 10) * 60;
    if (minMatch) totalMinutes += parseInt(minMatch[1], 10);
    const isEpic = totalMinutes >= 150 || d.includes("3h") || d.includes("4h");

    if (r >= 9.0) {
        return { key: "masterpiece", label: "👑 Masterpiece", class: "cat-masterpiece" };
    }
    if (isEpic) {
        return { key: "epics", label: "⏱️ Epic", class: "cat-epic" };
    }
    if (y >= 2010) {
        return { key: "modern", label: "🚀 Modern", class: "cat-modern" };
    }
    if (y >= 1990) {
        return { key: "millennial", label: "📼 90s/00s", class: "cat-90s" };
    }
    if (y > 0 && y < 1990) {
        return { key: "vintage", label: "📽️ Vintage", class: "cat-vintage" };
    }
    return { key: "top", label: "★ Top 250", class: "cat-modern" };
};

const matchesCategory = (movie, category) => {
    if (!category || category === "all") return true;
    const r = parseFloat(movie.rating) || 0;
    const y = parseInt(movie.year, 10) || 0;
    const d = movie.duration || "";
    let totalMinutes = 0;
    const hourMatch = d.match(/(\d+)\s*h/);
    const minMatch = d.match(/(\d+)\s*m/);
    if (hourMatch) totalMinutes += parseInt(hourMatch[1], 10) * 60;
    if (minMatch) totalMinutes += parseInt(minMatch[1], 10);

    if (category === "masterpiece") return r >= 9.0;
    if (category === "modern") return y >= 2010;
    if (category === "millennial") return y >= 1990 && y <= 2009;
    if (category === "vintage") return y > 0 && y < 1990;
    if (category === "epics") return totalMinutes >= 150 || d.includes("3h") || d.includes("4h");
    return true;
};

const updateCategoryCounts = () => {
    if (!movies || movies.length === 0) return;
    const counts = {
        all: movies.length,
        masterpiece: 0,
        modern: 0,
        millennial: 0,
        vintage: 0,
        epics: 0
    };
    movies.forEach((m) => {
        if (matchesCategory(m, "masterpiece")) counts.masterpiece++;
        if (matchesCategory(m, "modern")) counts.modern++;
        if (matchesCategory(m, "millennial")) counts.millennial++;
        if (matchesCategory(m, "vintage")) counts.vintage++;
        if (matchesCategory(m, "epics")) counts.epics++;
    });

    // Update quick filter chips
    document.querySelectorAll(".filter-chips-row .filter-chip").forEach((chip) => {
        const catKey = chip.getAttribute("data-category");
        if (catKey && counts[catKey] !== undefined) {
            if (!chip.getAttribute("data-base-label")) {
                chip.setAttribute("data-base-label", chip.textContent.trim());
            }
            const baseText = chip.getAttribute("data-base-label");
            chip.textContent = `${baseText} (${counts[catKey]})`;
        }
    });

    // Update categorySelect options
    if (categorySelect) {
        Array.from(categorySelect.options).forEach((opt) => {
            const val = opt.value;
            if (val && counts[val] !== undefined) {
                if (!opt.getAttribute("data-base-text")) {
                    opt.setAttribute("data-base-text", opt.textContent.trim());
                }
                const baseText = opt.getAttribute("data-base-text");
                opt.textContent = `${baseText} (${counts[val]})`;
            }
        });
    }
};

const setCategory = (cat) => {
    currentCategory = cat || "all";
    if (categorySelect) categorySelect.value = currentCategory;
    document.querySelectorAll(".filter-chips-row .filter-chip").forEach((btn) => {
        if (btn.getAttribute("data-category") === currentCategory) {
            btn.classList.add("active");
        } else {
            btn.classList.remove("active");
        }
    });
    currentPage = 1;
    renderTable();
};

// ============================================================================
// FETCH & UPDATE FUNCTIONS
// ============================================================================
const fetchStatus = async () => {
    try {
        const response = await fetch("/scrape-status");
        const data = await response.json();
        movies = data.data || [];
        const history = data.history || [];

        updateDashboard(data);
        updateCategoryCounts();
        renderTable();
        updateExport(data);
        updateAnalytics(data);
        renderHistory(history);
    } catch (error) {
        console.error("Status fetch failed", error);
    }
};

const updateDashboard = (data) => {
    const avg = movies.length
        ? (movies.reduce((sum, item) => sum + item.rating, 0) / movies.length).toFixed(2)
        : 0.0;

    setStatus(data.state, data.message || "Ready to scrape IMDb Top 250.");
    progressBar.style.width = `${data.progress || 0}%`;
    movieCount.textContent = `${data.count || 0} movies loaded`;
    liveCount.textContent = data.count || 0;
    avgRating.textContent = avg;
    progressText.textContent = `${data.progress || 0}%`;

    const mobileStatusText = document.getElementById("mobileStatusText");
    if (mobileStatusText) {
        mobileStatusText.textContent = formatStatus(data.state).toUpperCase();
    }

    // Dynamic polling speed adjustment
    if (data.state === "scraping") {
        startButton.disabled = true;
        stopButton.disabled = false;
        if (refreshDelay !== 300) {
            setPollingRate(300);
        }
    } else {
        startButton.disabled = false;
        stopButton.disabled = true;
        if (refreshDelay !== 2500) {
            setPollingRate(2500);
        }
    }
};

const scrollToTable = () => {
    const tablePanel = document.getElementById("tablePanel");
    if (tablePanel) {
        tablePanel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
};

const renderPagination = (totalItems) => {
    const paginationContainer = document.getElementById("paginationContainer");
    const paginationPages = document.getElementById("paginationPages");
    const prevBtn = document.getElementById("prevPageBtn");
    const nextBtn = document.getElementById("nextPageBtn");

    if (!paginationContainer || !paginationPages) return;

    const totalPages = Math.ceil(totalItems / itemsPerPage);

    if (totalPages <= 1) {
        paginationContainer.style.display = "none";
        return;
    }

    paginationContainer.style.display = "flex";

    // Prev / Next button states
    if (prevBtn) {
        prevBtn.disabled = (currentPage === 1);
        prevBtn.onclick = () => {
            if (currentPage > 1) {
                currentPage--;
                renderTable();
                scrollToTable();
            }
        };
    }

    if (nextBtn) {
        nextBtn.disabled = (currentPage === totalPages);
        nextBtn.onclick = () => {
            if (currentPage < totalPages) {
                currentPage++;
                renderTable();
                scrollToTable();
            }
        };
    }

    // Build page numbers matching uploaded image: < Prev  1  2  3  4 ... 10  Next >
    let pages = [];
    if (totalPages <= 7) {
        for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
        if (currentPage <= 4) {
            pages = [1, 2, 3, 4, "...", totalPages];
        } else if (currentPage >= totalPages - 3) {
            pages = [1, "...", totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
        } else {
            pages = [1, "...", currentPage - 1, currentPage, currentPage + 1, "...", totalPages];
        }
    }

    paginationPages.innerHTML = pages
        .map((p) => {
            if (p === "...") {
                return `<span class="page-ellipsis">...</span>`;
            }
            const isActive = (p === currentPage);
            return `<button type="button" class="page-number-btn ${isActive ? "active" : ""}" data-page="${p}">${p}</button>`;
        })
        .join("");

    paginationPages.querySelectorAll(".page-number-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            const page = parseInt(btn.getAttribute("data-page"), 10);
            if (!isNaN(page) && page !== currentPage) {
                currentPage = page;
                renderTable();
                scrollToTable();
            }
        });
    });
};

const renderTable = () => {
    const term = searchInput.value.trim().toLowerCase();
    const threshold = parseFloat(ratingFilter.value);

    // 1. Filter by search, rating threshold, and category
    let filtered = movies.filter((movie) => {
        const title = (movie.title || "").toLowerCase();
        const matchesSearch = title.includes(term);
        const matchesRating = isNaN(threshold) ? true : (parseFloat(movie.rating) || 0) >= threshold;
        const matchesCat = matchesCategory(movie, currentCategory);
        return matchesSearch && matchesRating && matchesCat;
    });

    // 2. Sort movies according to currentSort
    filtered.sort((a, b) => {
        const rankA = parseInt(a.rank, 10) || 999;
        const rankB = parseInt(b.rank, 10) || 999;
        const ratingA = parseFloat(a.rating) || 0;
        const ratingB = parseFloat(b.rating) || 0;
        const yearA = parseInt(a.year, 10) || 0;
        const yearB = parseInt(b.year, 10) || 0;
        const titleA = (a.title || "").toLowerCase();
        const titleB = (b.title || "").toLowerCase();

        switch (currentSort) {
            case "rank-desc":
                return rankB - rankA;
            case "rating-desc":
                return ratingB - ratingA || rankA - rankB;
            case "rating-asc":
                return ratingA - ratingB || rankA - rankB;
            case "year-desc":
                return yearB - yearA || rankA - rankB;
            case "year-asc":
                return yearA - yearB || rankA - rankB;
            case "title-asc":
                return titleA.localeCompare(titleB);
            case "title-desc":
                return titleB.localeCompare(titleA);
            case "rank-asc":
            default:
                return rankA - rankB;
        }
    });

    const movieCardsGrid = document.getElementById("movieCardsGrid");
    const totalFiltered = filtered.length;
    const totalPages = Math.ceil(totalFiltered / itemsPerPage) || 1;

    if (currentPage > totalPages) {
        currentPage = totalPages;
    }
    if (currentPage < 1) {
        currentPage = 1;
    }

    if (totalFiltered === 0) {
        const emptyHtml = `
            <div class="empty-state-cyber" style="grid-column: 1 / -1;">
                <div class="empty-icon-glow">⚡</div>
                <h4>${movies.length === 0 ? "No Movies Scraped Yet" : "No Movies Match Your Filter"}</h4>
                <p>${movies.length === 0 ? "Tap 'Start Scraping' above to extract IMDb Top 250 in seconds." : "Try adjusting your category, keyword, or min rating filter."}</p>
            </div>
        `;
        if (movieCardsGrid) movieCardsGrid.innerHTML = emptyHtml;
        if (movieTableBody) {
            movieTableBody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:32px; color:var(--text-muted);">${movies.length === 0 ? "No movies scraped yet. Tap Start Scraping." : "No movies match your filter."}</td></tr>`;
        }
        if (movieCount) movieCount.textContent = "0 movies found";
        renderPagination(0);
        return;
    }

    // Page slice (15 items per page by default)
    const startIdx = (currentPage - 1) * itemsPerPage;
    const endIdx = Math.min(startIdx + itemsPerPage, totalFiltered);
    const pagedMovies = filtered.slice(startIdx, endIdx);

    // Update loaded count text with range info
    if (movieCount) {
        const catNote = currentCategory !== "all" ? ` [${currentCategory.toUpperCase()}]` : "";
        movieCount.textContent = totalFiltered > itemsPerPage 
            ? `${startIdx + 1}–${endIdx} of ${totalFiltered} movies${catNote} (Page ${currentPage}/${totalPages})` 
            : `${totalFiltered} movies${catNote}`;
    }

    // Render Table View (Paged)
    if (movieTableBody) {
        movieTableBody.innerHTML = pagedMovies
            .map((movie) => {
                const cat = getMovieCategory(movie);
                return `
            <tr onclick="openMovieModal(${JSON.stringify(movie).replace(/"/g, '&quot;')})">
                <td class="rank-cell">#${movie.rank}</td>
                <td class="title-cell">
                    <div class="movie-title">
                        <div class="table-poster-wrap">
                            <img src="${getOptimizedPosterUrl(movie.poster, 120)}" alt="${movie.title}" class="movie-thumb" loading="lazy" onerror="this.style.opacity='0.2'" />
                        </div>
                        <div class="table-movie-info">
                            <span class="table-movie-name">${movie.title}</span>
                            <span class="table-category-pill ${cat.class}">${cat.label}</span>
                        </div>
                    </div>
                </td>
                <td class="year-cell">${movie.year || "—"}</td>
                <td class="duration-cell">${movie.duration || "—"}</td>
                <td class="rating-cell">
                    <span class="table-rating-badge">
                        <span class="star">★</span> ${(movie.rating || 0).toFixed(1)}
                    </span>
                </td>
            </tr>
        `;
            })
            .join("");
    }

    // Render Modern Card View (Paged with 15 per sort)
    if (movieCardsGrid) {
        movieCardsGrid.innerHTML = pagedMovies
            .map((movie) => {
                const cat = getMovieCategory(movie);
                return `
            <article class="scraped-movie-card" onclick="openMovieModal(${JSON.stringify(movie).replace(/"/g, '&quot;')})" tabindex="0">
                <div class="card-poster-wrap">
                    <img src="${getOptimizedPosterUrl(movie.poster, 200)}" alt="${movie.title}" class="card-poster" loading="lazy" onerror="this.style.opacity='0.2'" />
                    <span class="card-rank-badge">#${movie.rank}</span>
                </div>
                <div class="card-body">
                    <div class="card-top-row">
                        <h4 class="card-title">${movie.title}</h4>
                        <div class="card-rating-badge">
                            <span class="star-icon">★</span>
                            <span class="rating-num">${(movie.rating || 0).toFixed(1)}</span>
                        </div>
                    </div>
                    <div class="card-meta-chips">
                        <span class="meta-chip chip-category ${cat.class}">${cat.label}</span>
                        ${movie.year ? `<span class="meta-chip chip-year">${movie.year}</span>` : ""}
                        ${movie.duration ? `<span class="meta-chip chip-duration">${movie.duration}</span>` : ""}
                        ${movie.certificate ? `<span class="meta-chip chip-cert">${movie.certificate}</span>` : ""}
                    </div>
                    <div class="card-bottom-row">
                        <span class="card-votes">${movie.votes ? `👥 ${movie.votes} votes` : ""}</span>
                        <span class="card-view-link">Details →</span>
                    </div>
                </div>
            </article>
        `;
            })
            .join("");
    }

    // Render Pagination Controls
    renderPagination(totalFiltered);
};

const updateExport = (data) => {
    exportRowCount.textContent = movies.length;
    exportScrapeStatus.textContent = formatStatus(data.state).toUpperCase();
};

const updateAnalytics = (data) => {
    const totalMovies = movies.length;
    
    // Average Rating
    const avg = totalMovies
        ? (movies.reduce((sum, item) => sum + item.rating, 0) / totalMovies)
        : 0.0;
    
    document.getElementById("analyticsAvgRating").textContent = avg.toFixed(2);
    document.getElementById("analyticsAvgBar").style.width = `${(avg / 10.0) * 100}%`;
    
    // Max / Min Ratings
    let maxRating = 0.0;
    let minRating = 10.0;
    let bestMovie = null;
    
    movies.forEach(movie => {
        if (movie.rating > maxRating) {
            maxRating = movie.rating;
            bestMovie = movie;
        }
        if (movie.rating < minRating) {
            minRating = movie.rating;
        }
    });
    
    if (totalMovies === 0) {
        minRating = 0.0;
    }
    
    document.getElementById("analyticsMaxRating").textContent = maxRating.toFixed(1);
    document.getElementById("analyticsMaxBar").style.width = `${(maxRating / 10.0) * 100}%`;
    document.getElementById("analyticsMinRating").textContent = minRating.toFixed(1);
    document.getElementById("analyticsMinBar").style.width = `${(minRating / 10.0) * 100}%`;
    
    // Rating Categories Count
    let superb = 0; // 9.0+
    let excellent = 0; // 8.5 - 8.9
    let veryGood = 0; // 8.0 - 8.4
    let good = 0; // under 8.0
    
    movies.forEach(m => {
        if (m.rating >= 9.0) superb++;
        else if (m.rating >= 8.5) excellent++;
        else if (m.rating >= 8.0) veryGood++;
        else good++;
    });
    
    document.getElementById("countSuperb").textContent = `${superb} (${totalMovies ? Math.round(superb / totalMovies * 100) : 0}%)`;
    document.getElementById("countExcellent").textContent = `${excellent} (${totalMovies ? Math.round(excellent / totalMovies * 100) : 0}%)`;
    document.getElementById("countVeryGood").textContent = `${veryGood} (${totalMovies ? Math.round(veryGood / totalMovies * 100) : 0}%)`;
    document.getElementById("countGood").textContent = `${good} (${totalMovies ? Math.round(good / totalMovies * 100) : 0}%)`;
    
    // Top Movie Highlight
    const bestMovieHighlight = document.getElementById("bestMovieHighlight");
    if (bestMovie) {
        bestMovieHighlight.style.display = "block";
        document.getElementById("bestMoviePoster").src = bestMovie.poster;
        document.getElementById("bestMovieTitle").textContent = bestMovie.title;
        document.getElementById("bestMovieRating").textContent = bestMovie.rating.toFixed(1);
        document.getElementById("bestMovieRank").textContent = `Rank: #${bestMovie.rank} (${bestMovie.year})`;
    } else {
        bestMovieHighlight.style.display = "none";
    }
    
    // Update Chart
    renderChart();
};

const renderChart = () => {
    const canvas = document.getElementById("ratingsChartCanvas");
    if (!canvas) return;
    
    const ratingLabels = ['8.0', '8.1', '8.2', '8.3', '8.4', '8.5', '8.6', '8.7', '8.8', '8.9', '9.0', '9.1', '9.2', '9.3'];
    const ratingCounts = new Array(ratingLabels.length).fill(0);
    
    movies.forEach(m => {
        const ratingStr = m.rating.toFixed(1);
        const idx = ratingLabels.indexOf(ratingStr);
        if (idx !== -1) {
            ratingCounts[idx]++;
        }
    });
    
    if (ratingChart) {
        ratingChart.data.datasets[0].data = ratingCounts;
        ratingChart.update();
    } else {
        const ctx = canvas.getContext('2d');
        ratingChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: ratingLabels,
                datasets: [{
                    label: 'Number of Movies',
                    data: ratingCounts,
                    backgroundColor: 'rgba(0, 240, 255, 0.35)',
                    borderColor: '#00f0ff',
                    borderWidth: 2,
                    borderRadius: 4,
                    hoverBackgroundColor: 'rgba(255, 0, 127, 0.55)',
                    hoverBorderColor: '#ff007f',
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        backgroundColor: '#0a0c18',
                        titleColor: '#00f0ff',
                        titleFont: { family: 'Orbitron' },
                        bodyFont: { family: 'Inter' },
                        borderColor: 'rgba(0, 240, 255, 0.2)',
                        borderWidth: 1,
                        displayColors: false
                    }
                },
                scales: {
                    x: {
                        grid: {
                            color: 'rgba(255, 255, 255, 0.05)',
                        },
                        ticks: {
                            color: '#7b8cb8',
                            font: { family: 'Share Tech Mono' }
                        }
                    },
                    y: {
                        grid: {
                            color: 'rgba(255, 255, 255, 0.05)',
                        },
                        ticks: {
                            color: '#7b8cb8',
                            font: { family: 'Share Tech Mono' },
                            stepSize: 1,
                            precision: 0
                        }
                    }
                }
            }
        });
    }
};

const renderHistory = (history = []) => {
    if (!historyTableBody) return;

    if (history.length === 0) {
        historyTableBody.innerHTML = `
            <tr><td colspan="6" class="empty-history">No scrape sessions available.</td></tr>
        `;
        return;
    }

    historyTableBody.innerHTML = history
        .slice(0, 8)
        .map((session) => {
            const start = session.started_at || "—";
            const range = `${session.start_rank || 1}-${session.end_rank || 250}`;
            const moviesCount = session.movie_count || 0;
            const avgRating = session.avg_rating ? session.avg_rating.toFixed(2) : "—";
            const duration = session.duration_secs !== null ? `${session.duration_secs}s` : "—";
            const status = formatStatus(session.state);

            return `
                <tr>
                    <td>${start}</td>
                    <td>${range}</td>
                    <td>${moviesCount}</td>
                    <td>${avgRating}</td>
                    <td>${status}</td>
                    <td>${duration}</td>
                </tr>
            `;
        })
        .join("");
};

// ============================================================================
// BUTTON HANDLERS
// ============================================================================
const startScrape = async () => {
    const headless = headlessToggle.checked;
    const limit = scrapeLimit.value ? parseInt(scrapeLimit.value, 10) : null;
    const requestedStart = parseInt(startRank.value, 10) || 1;
    const requestedEnd = parseInt(endRank.value, 10) || 250;

    if (requestedStart < 1 || requestedStart > 250 || requestedEnd < 1 || requestedEnd > 250) {
        alert("Please select a start and end rank between 1 and 250.");
        return;
    }

    if (requestedStart > requestedEnd) {
        alert("Start rank must be less than or equal to end rank.");
        return;
    }

    startButton.disabled = true;
    stopButton.disabled = false;

    try {
        const response = await fetch("/start-scrape", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                headless,
                limit,
                start_rank: requestedStart,
                end_rank: requestedEnd,
            }),
        });

        if (response.ok) {
            setPollingRate(300);
            fetchStatus();
        } else {
            const errorData = await response.json().catch(() => ({}));
            console.error("Start scrape failed:", errorData);
            startButton.disabled = false;
            stopButton.disabled = true;
        }
    } catch (error) {
        console.error("Start scrape failed:", error);
        startButton.disabled = false;
        stopButton.disabled = true;
    }
};

const stopScrape = async () => {
    stopButton.disabled = true;
    try {
        await fetch("/stop-scrape", {
            method: "POST",
        });
    } catch (error) {
        console.error("Stop scrape failed:", error);
    }
};

const downloadCsv = () => {
    if (movies.length === 0) {
        alert("No movie data to download. Please scrape first.");
        return;
    }
    window.location.href = "/download-csv";
};

// ============================================================================
// MODAL FUNCTIONS
// ============================================================================
const openMovieModal = (movie) => {
    document.getElementById("modalRank").textContent = `#${movie.rank}`;
    document.getElementById("modalTitle").textContent = movie.title;
    document.getElementById("modalYear").textContent = movie.year || "Unknown";
    document.getElementById("modalDuration").textContent = movie.duration || "Unknown";
    document.getElementById("modalCertificate").textContent = movie.certificate || "N/A";
    document.getElementById("modalRating").textContent = movie.rating.toFixed(1);
    document.getElementById("modalVotes").textContent = `(${movie.votes || "N/A"} votes)`;
    document.getElementById("modalPoster").src = getOptimizedPosterUrl(movie.poster, 360) || movie.poster || "";
    movieModal.style.display = "flex";
};

const closeMovieModal = () => {
    movieModal.style.display = "none";
};

// ============================================================================
// VIEW NAVIGATION & MODE
// ============================================================================
const switchView = (viewName) => {
    document.querySelectorAll(".nav-item, .dock-item").forEach((btn) => {
        if (btn.getAttribute("data-view") === viewName) {
            btn.classList.add("active");
        } else {
            btn.classList.remove("active");
        }
    });

    document.querySelectorAll(".view-container").forEach((view) => {
        view.classList.remove("active");
    });
    const target = document.getElementById(viewName);
    if (target) {
        target.classList.add("active");
        window.scrollTo({ top: 0, behavior: "smooth" });
    }
};

document.querySelectorAll(".nav-item, .dock-item").forEach((btn) => {
    btn.addEventListener("click", () => {
        const viewName = btn.getAttribute("data-view");
        if (viewName) switchView(viewName);
    });
});

// View Mode Toggle (Cards vs Table)
const viewCardsBtn = document.getElementById("viewCardsBtn");
const viewTableBtn = document.getElementById("viewTableBtn");
const movieCardsContainer = document.getElementById("movieCardsContainer");
const tableWrapper = document.getElementById("tableWrapper");

const setViewMode = (mode) => {
    if (mode === "cards") {
        if (movieCardsContainer) movieCardsContainer.style.display = "block";
        if (tableWrapper) tableWrapper.style.display = "none";
        if (viewCardsBtn) viewCardsBtn.classList.add("active");
        if (viewTableBtn) viewTableBtn.classList.remove("active");
    } else {
        if (movieCardsContainer) movieCardsContainer.style.display = "none";
        if (tableWrapper) tableWrapper.style.display = "block";
        if (viewCardsBtn) viewCardsBtn.classList.remove("active");
        if (viewTableBtn) viewTableBtn.classList.add("active");
    }
};

if (viewCardsBtn) {
    viewCardsBtn.addEventListener("click", () => setViewMode("cards"));
}
if (viewTableBtn) {
    viewTableBtn.addEventListener("click", () => setViewMode("table"));
}

// Quick category filter chips
document.querySelectorAll(".filter-chips-row .filter-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
        const cat = chip.getAttribute("data-category") || "all";
        setCategory(cat);
    });
});

// Sort, Category, and Per-Page Dropdown Controls
if (sortBySelect) {
    sortBySelect.addEventListener("change", () => {
        currentSort = sortBySelect.value;
        currentPage = 1;
        renderTable();
    });
}

if (categorySelect) {
    categorySelect.addEventListener("change", () => {
        setCategory(categorySelect.value);
    });
}

if (perPageSelect) {
    perPageSelect.addEventListener("change", () => {
        itemsPerPage = parseInt(perPageSelect.value, 10) || 15;
        currentPage = 1;
        renderTable();
    });
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================
startButton.addEventListener("click", () => {
    currentPage = 1;
    startScrape();
});
stopButton.addEventListener("click", stopScrape);
downloadButton.addEventListener("click", downloadCsv);
exportDownloadBtn.addEventListener("click", downloadCsv);
searchInput.addEventListener("input", () => {
    currentPage = 1;
    renderTable();
});
ratingFilter.addEventListener("input", () => {
    currentPage = 1;
    renderTable();
});
modalClose.addEventListener("click", closeMovieModal);

movieModal.addEventListener("click", (e) => {
    if (e.target === movieModal) {
        closeMovieModal();
    }
});

// ============================================================================
// INITIALIZATION
// ============================================================================
window.addEventListener("DOMContentLoaded", () => {
    // Default to Cards view on mobile, or Table on large screens if desired
    if (window.innerWidth <= 768) {
        setViewMode("cards");
    } else {
        setViewMode("cards"); // Cards look stunning on both, with toggle to Table
    }

    fetchStatus();
    if (!pollInterval) {
        pollInterval = setInterval(fetchStatus, refreshDelay);
    }
});
