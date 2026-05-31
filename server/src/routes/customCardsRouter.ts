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

const mythicBlackCoreLimiter = new Bottleneck({
    maxConcurrent: 3,
    minTime: 300,
});

interface CustomCard {
    id: string;
    name: string;
    imageUrl: string;
    /** Fallback image URL (lower quality) used when primary fails */
    fallbackUrl?: string;
    source: "mtgcardsmith" | "mtgcardbuilder" | "mythicblackcore";
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
 * Core API call to MTG Card Builder with optional category filter
 */
async function fetchCardBuilderPage(query: string, page: number = 1, category?: string): Promise<PagedResults> {
    const url = "https://mtgcardbuilder.com/wp-admin/admin-ajax.php";

    const params = new URLSearchParams();
    params.append('search', query);
    params.append('order', 'recent');
    params.append('nsfw', '0');
    params.append('other', '0');
    params.append('cpage', String(page));
    if (category) params.append('category', category);
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
                // Use the download.php endpoint for higher quality images
                // e.g. https://mtgcardbuilder.com/download.php?download=https://mtgcardbuilder.com/custom_db/custom_visual/tmp_xxx.png
                const originalUrl = item.image_url as string;
                const highQualityUrl = originalUrl.includes('mtgcardbuilder.com/')
                    ? `https://mtgcardbuilder.com/download.php?download=${originalUrl}`
                    : originalUrl; // S3 URLs stay as-is
                results.push({
                    id: `mtgcardbuilder-${item.id}`,
                    name: item.card_edition || item.search_card_name || "Untitled Card",
                    imageUrl: highQualityUrl,
                    source: "mtgcardbuilder",
                    author: item.user_name,
                    url: originalUrl // Link to original for reference
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

/**
 * Search MTG Card Builder with pagination support.
 * Also searches with category=token in parallel to capture token results
 * that may not appear in the general search.
 */
async function searchMtgCardBuilder(query: string, page: number = 1, includeTokens: boolean = false, category?: string): Promise<PagedResults> {
    const searches = [fetchCardBuilderPage(query, page, category)];
    if (includeTokens && category !== 'token') {
        searches.push(fetchCardBuilderPage(query, page, 'token'));
    }
    const results = await Promise.all(searches);

    const generalResult = results[0];
    const tokenResult = includeTokens ? results[1] : { cards: [] as CustomCard[], hasMore: false };

    // Merge results, deduplicating by id
    const seenIds = new Set<string>();
    const merged: CustomCard[] = [];
    for (const card of [...generalResult.cards, ...tokenResult.cards]) {
        if (!seenIds.has(card.id)) {
            seenIds.add(card.id);
            merged.push(card);
        }
    }

    return {
        cards: merged,
        hasMore: generalResult.hasMore || tokenResult.hasMore,
    };
}

/**
 * Extract proof (full quality) and web (thumbnail) image URLs from a Mythic Black Core API item.
 * Returns both URLs so the client can try proof first and fall back to web.
 *
 * IMPORTANT: design_date from the MBC API is the *last modification* date, NOT the upload date
 * that determines the S3 path. Using it to construct URLs produces wrong dates (404s).
 * Instead, we derive the proof URL from the web URL (which has the correct date path).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractMythicBlackCoreImageUrls(item: any): { proofUrl: string; webUrl: string } {
    let proofUrl = '';
    let webUrl = '';

    // Try metadata first (has full-quality and web paths)
    if (item.metadata && item.metadata.wasabi && item.metadata.wasabi.storage) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const storage of item.metadata.wasabi.storage as any[]) {
            if (storage.full && storage.full.path && storage.full.status === 'ok') {
                const fullPath = storage.full.path as string;
                if (fullPath.includes('://') && !proofUrl) {
                    proofUrl = fullPath;
                }
            }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const storage of item.metadata.wasabi.storage as any[]) {
            if (storage.web && storage.web.path && !webUrl) {
                webUrl = storage.web.path as string;
            }
        }
    }

    // Derive proof URL from web URL by replacing /web/ with /proof/
    // This works because both paths share the same date-based directory structure,
    // and the web URL has the correct date (unlike design_date).
    if (!proofUrl && webUrl) {
        proofUrl = webUrl.replace('/storage/card/web/', '/storage/card/proof/');
    }
    // Derive web URL from proof URL if only proof is available
    if (!webUrl && proofUrl) {
        webUrl = proofUrl.replace('/storage/card/proof/', '/storage/card/web/');
    }

    // Last resort: construct URLs from design_date and id.
    // NOTE: design_date is the last-modification date, NOT the upload date,
    // so the path may be wrong (causing 404s). But it's better to show a
    // broken image than to omit the card entirely — the fallback mechanism
    // will try the web URL if proof fails.
    if (!proofUrl && !webUrl && item.design_date && item.id) {
        const parts = (item.design_date as string).split(' ')[0].split('-');
        if (parts.length === 3) {
            const base = `https://s3.us-west-1.wasabisys.com/mythicblackcore-wasabifs/storage/card`;
            proofUrl = `${base}/proof/${parts[0]}/${parts[1]}/${parts[2]}/${item.id}.png`;
            webUrl = `${base}/web/${parts[0]}/${parts[1]}/${parts[2]}/${item.id}.png`;
        }
    }

    return { proofUrl, webUrl };
}

/**
 * Core API call to Mythic Black Core with optional category filter
 */
async function fetchMythicBlackCorePage(query: string, page: number = 1, category?: string): Promise<PagedResults> {
    const url = "https://www.mythicblackcore.com/ajax/gallery.php";

    const params = new URLSearchParams();
    if (category) {
        // Category browsing uses getGalleryCards
        params.append('category', category);
        params.append('user', '');
        params.append('ajax_action', 'getGalleryCards');
        params.append('ajax_in_site', 'true');
    } else {
        // Search uses searchGalleryCards
        params.append('cpage', String(page));
        params.append('type', 'search');
        params.append('val', '');
        params.append('search', query);
        params.append('order', 'recent');
        params.append('nsfw', '0');
        params.append('other', '0');
        params.append('ajax_action', 'searchGalleryCards');
    }
    if (!category) {
        params.append('cpage', String(page));
    } else {
        params.append('cpage', String(page));
    }

    const { data } = await axios.post(url, params, {
        headers: {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:147.0) Gecko/20100101 Firefox/147.0",
            "Origin": "https://www.mythicblackcore.com",
            "Referer": "https://www.mythicblackcore.com/gallery/?index=1",
            "Content-Type": "application/x-www-form-urlencoded"
        },
        timeout: 10000
    });

    const results: CustomCard[] = [];

    if (data && Array.isArray(data.data)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data.data.forEach((item: any) => {
            const { proofUrl, webUrl } = extractMythicBlackCoreImageUrls(item);
            if (!proofUrl && !webUrl) return;

            results.push({
                id: `mythicblackcore-${item.id}`,
                name: item.card_edition || item.search_card_name || "Untitled Card",
                imageUrl: proofUrl || webUrl,
                fallbackUrl: webUrl && webUrl !== (proofUrl || webUrl) ? webUrl : undefined,
                source: "mythicblackcore",
                author: item.user_name || item.user_id,
                url: `https://www.mythicblackcore.com/gallery/?index=1`,
            });
        });
    }

    const hasMore = results.length > 0;

    return { cards: results, hasMore };
}

/**
 * Search Mythic Black Core with pagination support.
 * Also searches with category=token in parallel to capture token results.
 */
async function searchMythicBlackCore(query: string, page: number = 1, includeTokens: boolean = false, category?: string): Promise<PagedResults> {
    const searches = [fetchMythicBlackCorePage(query, page, category)];
    if (includeTokens && category !== 'token') {
        searches.push(fetchMythicBlackCorePage(query, page, 'token'));
    }
    const results = await Promise.all(searches);

    const generalResult = results[0];
    const tokenResult = includeTokens ? results[1] : { cards: [] as CustomCard[], hasMore: false };

    // Merge results, deduplicating by id
    const seenIds = new Set<string>();
    const merged: CustomCard[] = [];
    for (const card of [...generalResult.cards, ...tokenResult.cards]) {
        if (!seenIds.has(card.id)) {
            seenIds.add(card.id);
            merged.push(card);
        }
    }

    return {
        cards: merged,
        hasMore: generalResult.hasMore || tokenResult.hasMore,
    };
}

// Wrapped versions for rate limiting
const wrappedSearchCardsmith = cardsmithLimiter.wrap(searchMtgCardsmith);
const wrappedSearchCardBuilder = cardbuilderLimiter.wrap(searchMtgCardBuilder);
const wrappedSearchMythicBlackCore = mythicBlackCoreLimiter.wrap(searchMythicBlackCore);

// Helper to convert CustomCard to MpcCard format for caching/client compatibility
function mapToMpcCard(card: CustomCard): MpcCard {
    const sourceTag = card.source === "mtgcardsmith" ? "Cardsmith"
        : card.source === "mtgcardbuilder" ? "CardBuilder"
        : "MythicBlackCore";
    const sourceName = card.source === "mtgcardsmith" ? "MTG Cardsmith"
        : card.source === "mtgcardbuilder" ? "MTG Card Builder"
        : "Mythic Black Core";

    return {
        identifier: card.imageUrl, // Use imageUrl as identifier for proxying
        name: card.name,
        smallThumbnailUrl: card.fallbackUrl || card.imageUrl,
        mediumThumbnailUrl: card.fallbackUrl || card.imageUrl,
        dpi: 300,
        tags: ["Custom", sourceTag],
        sourceName,
        source: card.url,
        extension: (card.url || card.imageUrl).split('.').pop()?.split(/[?#]/)[0] || "png",
        size: 0
    };
}

interface SearchResult {
    cards: MpcCard[];
    hasMoreCardsmith: boolean;
    hasMoreCardbuilder: boolean;
    hasMoreMythicBlackCore: boolean;
}

/**
 * Perform a search for a single query (cached or fresh)
 */
async function performSearch(query: string, sourceFilter?: string, page: number = 1, cardsmithSort: "newest" | "oldest" | "favorites" = "newest", includeTokens: boolean = false, category?: string): Promise<SearchResult> {
    const normalizedQuery = query.toLowerCase().trim();
    // Cache key includes source filter, page number, cardsmith sort, token flag, and category
    // v7: Added category to avoid category/non-category cache collisions
    const cacheKey = `${normalizedQuery}:custom:${sourceFilter || 'all'}:p${page}:s${cardsmithSort}:t${includeTokens ? '1' : '0'}:c${category || 'all'}:v7`;

    // Check cache (only for page 1 — subsequent pages are not cached to avoid stale pagination)
    if (page === 1) {
        const cached = getCachedMpcSearch(cacheKey, "CUSTOM");
        if (cached && cached.length > 0) {
            // Cached results don't have hasMore metadata.
            // Assume more pages exist whenever there are any results from that source
            // (consistent with the live-fetch fallback; one extra empty-page click is acceptable).
            const csCards = cached.filter(c => c.sourceName === "MTG Cardsmith");
            const cbCards = cached.filter(c => c.sourceName === "MTG Card Builder");
            const mbcCards = cached.filter(c => c.sourceName === "Mythic Black Core");
            return {
                cards: cached,
                hasMoreCardsmith: csCards.length > 0,
                hasMoreCardbuilder: cbCards.length > 0,
                hasMoreMythicBlackCore: mbcCards.length > 0,
            };
        }
    }

    let cardsmithPromise: Promise<PagedResults> | undefined;
    let cardbuilderPromise: Promise<PagedResults> | undefined;
    let mythicBlackCorePromise: Promise<PagedResults> | undefined;

    if (!sourceFilter || sourceFilter === 'mtgcardsmith') {
        cardsmithPromise = wrappedSearchCardsmith(query, page, cardsmithSort);
    }

    if (!sourceFilter || sourceFilter === 'mtgcardbuilder') {
        cardbuilderPromise = wrappedSearchCardBuilder(query, page, includeTokens, category);
    }

    if (!sourceFilter || sourceFilter === 'mythicblackcore') {
        mythicBlackCorePromise = wrappedSearchMythicBlackCore(query, page, includeTokens, category);
    }

    let cardsmithResult: PagedResults = { cards: [], hasMore: false };
    let cardbuilderResult: PagedResults = { cards: [], hasMore: false };
    let mythicBlackCoreResult: PagedResults = { cards: [], hasMore: false };
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

    if (mythicBlackCorePromise) {
        try {
            mythicBlackCoreResult = await mythicBlackCorePromise;
        } catch (error) {
            console.error(`[CustomCards] Mythic Black Core search failed for "${query}":`, error);
            partialFailure = true;
        }
    }

    const allResults = [...cardsmithResult.cards, ...cardbuilderResult.cards, ...mythicBlackCoreResult.cards].map(mapToMpcCard);

    // Cache page 1 results only, and only if no partial failure occurred.
    if (page === 1 && !partialFailure) {
        cacheMpcSearch(cacheKey, "CUSTOM", allResults);
    }

    return {
        cards: allResults,
        hasMoreCardsmith: cardsmithResult.hasMore,
        hasMoreCardbuilder: cardbuilderResult.hasMore,
        hasMoreMythicBlackCore: mythicBlackCoreResult.hasMore,
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
    const includeTokens = req.query.includeTokens === '1';
    const category = req.query.category as string | undefined;

    if (!q) {
        return res.status(400).json({ error: "Missing q parameter" });
    }

    try {
        const result = await performSearch(q, source, page, cardsmithSort, includeTokens, category);

        return res.json({
            object: "list",
            total_cards: result.cards.length,
            data: result.cards,
            hasMoreCardsmith: result.hasMoreCardsmith,
            hasMoreCardbuilder: result.hasMoreCardbuilder,
            hasMoreMythicBlackCore: result.hasMoreMythicBlackCore,
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
        const cacheKey = `${normalizedQuery}:custom:${sourceFilter || 'all'}:p1:snewest:t0:v6`;
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
