import express, { type Request, type Response } from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import Bottleneck from "bottleneck";
import { getCachedMpcSearch, cacheMpcSearch, type MpcCard } from "../db/mpcSearchCache.js";

const router = express.Router();

// Rate limiters
const cardsmithLimiter = new Bottleneck({
    maxConcurrent: 2,
    minTime: 1000,
});

const cardbuilderLimiter = new Bottleneck({
    maxConcurrent: 5, // API is likely faster/more robust
    minTime: 200,
});

interface CustomCard {
    id: string;
    name: string;
    imageUrl: string;
    source: "mtgcardsmith" | "mtgcardbuilder";
    author?: string;
    url: string;
}

interface PagedResults {
    cards: CustomCard[];
    hasMore: boolean;
}

/**
 * Search MTG Cardsmith using the AJAX gallery loader endpoint.
 * This endpoint returns card HTML + pagination (total pages) at the bottom.
 */
async function searchMtgCardsmith(query: string, page: number = 1, sort: "newest" | "oldest" | "favorites" = "newest"): Promise<PagedResults> {
    const searchUrl = `https://mtgcardsmith.com/wp-content/themes/hello-elementor-child/ajax/ajax-gallery-loader.php?page=${page}&search=${encodeURIComponent(query)}&type=&mana=&sort=${sort}`;

    const { data } = await axios.get(searchUrl, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
            "Referer": "https://mtgcardsmith.com/gallery",
        },
        timeout: 10000
    });

    const $ = cheerio.load(data);
    const results: CustomCard[] = [];

    // The ajax-gallery-loader.php endpoint returns div.col_list elements
    $(".col_list").each((_: number, element: unknown) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const $el = $(element as any);

        // Title: in h3 > a
        const name = $el.find("h3 a").first().text().trim() ||
                     $el.find("h3").first().text().trim() ||
                     "Untitled Card";

        // Author: in h4 > a with /user/ href
        const $authorLink = $el.find("h4 a[href*='/user/']").first();
        const author = $authorLink.text().trim();

        // Image: prefer data-full (high-res) over src
        const $img = $el.find("img").first();
        let imageUrl = $img.attr("data-full") || $img.attr("src") || $img.attr("data-src") || "";
        if (imageUrl.startsWith("/")) imageUrl = `https://mtgcardsmith.com${imageUrl}`;

        if (!imageUrl) return;

        // Try to extract card slug from onclick="openView('slug')" to build real URL
        const onclick = $el.find("h3 a, img").first().attr("onclick") || "";
        const slugMatch = onclick.match(/openView\('([^']+)'\)/);
        const slug = slugMatch?.[1];
        const cardUrl = slug ? `https://mtgcardsmith.com/view/${slug}` : imageUrl;

        results.push({
            id: `mtgcardsmith-${slug || imageUrl.split("/").pop()?.split(".")[0] || Math.random().toString(36).substr(2, 9)}`,
            name,
            imageUrl,
            source: "mtgcardsmith",
            author,
            url: cardUrl,
        });
    });

    // Parse total pages from pagination — the response ends with numbered page links.
    // Extract the highest page number from any link or span text.
    let totalPages = page;
    $("a, span").each((_: number, el: unknown) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const text = ($(el as any).text() || "").trim();
        const num = parseInt(text, 10);
        if (!isNaN(num) && num > totalPages) totalPages = num;
    });

    return { cards: results, hasMore: page < totalPages };
}


/**
 * Search MTG Card Builder with pagination support
 */
async function searchMtgCardBuilder(query: string, page: number = 1): Promise<PagedResults> {
    const url = "https://mtgcardbuilder.com/wp-admin/admin-ajax.php";

    const params = new URLSearchParams();
    params.append('search', query);
    params.append('order', 'recent');
    params.append('nsfw', '0');
    params.append('other', '0');
    params.append('cpage', String(page));
    params.append('action', 'builder_ajax');
    params.append('method', 'search_gallery_cards');

    const { data } = await axios.post(url, params, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
            "Origin": "https://mtgcardbuilder.com",
            "Referer": "https://mtgcardbuilder.com/mtg-custom-card-gallery/",
            "Content-Type": "application/x-www-form-urlencoded"
        },
        timeout: 10000
    });

    const results: CustomCard[] = [];

    if (data && Array.isArray(data.data)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data.data.forEach((item: any) => {
            if (item.image_url) {
                results.push({
                    id: `mtgcardbuilder-${item.id}`,
                    name: item.card_edition || item.search_card_name || "Untitled Card",
                    imageUrl: item.image_url,
                    source: "mtgcardbuilder",
                    author: item.user_name,
                    url: item.image_url // Use image URL as link for now
                });
            }
        });
    }

    // Don't rely on data.total — MTGCardBuilder may return the current page count
    // rather than the overall total, making page * PAGE_SIZE < total always false.
    // Instead, assume more pages exist whenever we got any results on this page.
    const hasMore = results.length > 0;

    return { cards: results, hasMore };
}

// Wrapped versions for rate limiting
const wrappedSearchCardsmith = cardsmithLimiter.wrap(searchMtgCardsmith);
const wrappedSearchCardBuilder = cardbuilderLimiter.wrap(searchMtgCardBuilder);

// Helper to convert CustomCard to MpcCard format for caching/client compatibility
function mapToMpcCard(card: CustomCard): MpcCard {
    return {
        identifier: card.imageUrl, // Use imageUrl as identifier for proxying
        name: card.name,
        smallThumbnailUrl: card.imageUrl,
        mediumThumbnailUrl: card.imageUrl,
        dpi: 300,
        tags: ["Custom", card.source === "mtgcardsmith" ? "Cardsmith" : "CardBuilder"],
        sourceName: card.source === "mtgcardsmith" ? "MTG Cardsmith" : "MTG Card Builder",
        source: card.url,
        extension: card.imageUrl.split('.').pop()?.split(/[?#]/)[0] || "png",
        size: 0
    };
}

interface SearchResult {
    cards: MpcCard[];
    hasMoreCardsmith: boolean;
    hasMoreCardbuilder: boolean;
}

/**
 * Perform a search for a single query (cached or fresh)
 */
async function performSearch(query: string, sourceFilter?: string, page: number = 1, cardsmithSort: "newest" | "oldest" | "favorites" = "newest"): Promise<SearchResult> {
    const normalizedQuery = query.toLowerCase().trim();
    // Cache key includes source filter, page number, and cardsmith sort
    // v3: Bumped cache version to clear results cached with wrong selectors (col_list fix)
    const cacheKey = `${normalizedQuery}:custom:${sourceFilter || 'all'}:p${page}:s${cardsmithSort}:v3`;

    // Check cache (only for page 1 — subsequent pages are not cached to avoid stale pagination)
    if (page === 1) {
        const cached = getCachedMpcSearch(cacheKey, "CUSTOM");
        if (cached && cached.length > 0) {
            // Cached results don't have hasMore metadata.
            // Assume more pages exist whenever there are any results from that source
            // (consistent with the live-fetch fallback; one extra empty-page click is acceptable).
            const csCards = cached.filter(c => c.sourceName === "MTG Cardsmith");
            const cbCards = cached.filter(c => c.sourceName === "MTG Card Builder");
            return {
                cards: cached,
                hasMoreCardsmith: csCards.length > 0,
                hasMoreCardbuilder: cbCards.length > 0,
            };
        }
    }

    let cardsmithPromise: Promise<PagedResults> | undefined;
    let cardbuilderPromise: Promise<PagedResults> | undefined;

    if (!sourceFilter || sourceFilter === 'mtgcardsmith') {
        cardsmithPromise = wrappedSearchCardsmith(query, page, cardsmithSort);
    }

    if (!sourceFilter || sourceFilter === 'mtgcardbuilder') {
        cardbuilderPromise = wrappedSearchCardBuilder(query, page);
    }

    let cardsmithResult: PagedResults = { cards: [], hasMore: false };
    let cardbuilderResult: PagedResults = { cards: [], hasMore: false };
    let partialFailure = false;

    if (cardsmithPromise) {
        try {
            cardsmithResult = await cardsmithPromise;
        } catch (error) {
            console.error(`[CustomCards] Cardsmith search failed for "${query}":`, error);
            partialFailure = true;
        }
    }

    if (cardbuilderPromise) {
        try {
            cardbuilderResult = await cardbuilderPromise;
        } catch (error) {
            console.error(`[CustomCards] CardBuilder search failed for "${query}":`, error);
            partialFailure = true;
        }
    }

    const allResults = [...cardsmithResult.cards, ...cardbuilderResult.cards].map(mapToMpcCard);

    // Cache page 1 results only, and only if no partial failure occurred.
    if (page === 1 && !partialFailure) {
        cacheMpcSearch(cacheKey, "CUSTOM", allResults);
    }

    return {
        cards: allResults,
        hasMoreCardsmith: cardsmithResult.hasMore,
        hasMoreCardbuilder: cardbuilderResult.hasMore,
    };
}

// Track background jobs
const activeJobs = new Set<string>();

/**
 * GET /api/custom/search
 * Single card search with optional pagination
 */
router.get("/search", async (req: Request, res: Response) => {
    const q = req.query.q as string;
    const source = req.query.source as string | undefined; // 'mtgcardsmith' or 'mtgcardbuilder'
    const page = parseInt(req.query.page as string) || 1;
    const rawSort = req.query.sort as string | undefined;
    const cardsmithSort: "newest" | "oldest" | "favorites" =
        rawSort === "oldest" || rawSort === "favorites" ? rawSort : "newest";

    if (!q) {
        return res.status(400).json({ error: "Missing q parameter" });
    }

    try {
        const result = await performSearch(q, source, page, cardsmithSort);

        return res.json({
            object: "list",
            total_cards: result.cards.length,
            data: result.cards,
            hasMoreCardsmith: result.hasMoreCardsmith,
            hasMoreCardbuilder: result.hasMoreCardbuilder,
        });
    } catch (error) {
        console.error("[CustomCards] Search failed:", error);
        return res.status(500).json({ error: "Failed to search custom cards" });
    }
});

/**
 * POST /api/custom/batch-search
 * Batch search for multiple cards.
 * Returns cached results immediately and queues uncached ones.
 */
router.post("/batch-search", async (req: Request, res: Response) => {
    const { queries, source: sourceFilter } = req.body;

    if (!queries || !Array.isArray(queries)) {
        return res.status(400).json({ error: "Missing or invalid queries array" });
    }

    const results: Record<string, MpcCard[]> = {};
    const queued: string[] = [];

    // Check cache for all queries
    for (const query of queries) {
        const normalizedQuery = query.toLowerCase().trim();
        const cacheKey = `${normalizedQuery}:custom:${sourceFilter || 'all'}:p1:snewest:v3`;
        const cached = getCachedMpcSearch(cacheKey, "CUSTOM");

        if (cached) {
            results[query] = cached;
        } else {
            // Queue for background processing
            queued.push(query);

            // Start background job if not already running
            if (!activeJobs.has(cacheKey)) {
                activeJobs.add(cacheKey);
                performSearch(query, sourceFilter, 1)
                    .finally(() => {
                        activeJobs.delete(cacheKey);
                    });
            }
        }
    }

    return res.json({
        results,
        queued,
        message: queued.length > 0 ? `Queued ${queued.length} queries for background processing` : "All results returned from cache"
    });
});

export { router as customCardsRouter };
