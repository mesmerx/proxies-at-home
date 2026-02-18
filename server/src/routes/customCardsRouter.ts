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

/**
 * Search MTG Cardsmith
 */
async function searchMtgCardsmith(query: string): Promise<CustomCard[]> {
    const searchUrl = `https://mtgcardsmith.com/search?q=${encodeURIComponent(query)}`;
    
    const { data } = await axios.get(searchUrl, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        },
        timeout: 10000
    });

    const $ = cheerio.load(data);
    const results: CustomCard[] = [];

    $(".card-item").each((_: number, element: unknown) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const $el = $(element as any);
        const $img = $el.find("img.card");
        const $link = $el.find(".panel > a");
        const $title = $el.find("h6.subheader");
        const $author = $el.find("cite > a");

        if ($img.length && $title.length) {
            let imageUrl = $img.attr("src") || "";
            if (imageUrl.startsWith("/")) {
                imageUrl = `https://mtgcardsmith.com${imageUrl}`;
            }
            
            // Try to get high-res image from onclick attribute
            const onclick = $el.find(".addToPrintOrder").attr("onclick");
            if (onclick) {
                const match = onclick.match(/addToList\(this,`([^`]+)`\)/);
                if (match && match[1]) {
                    imageUrl = match[1];
                }
            }

            const url = $link.attr("href") || "";
            const fullUrl = url.startsWith("/") ? `https://mtgcardsmith.com${url}` : url;

            results.push({
                id: `mtgcardsmith-${url.split("/").pop() || Math.random().toString(36).substr(2, 9)}`,
                name: $title.text().trim(),
                imageUrl,
                source: "mtgcardsmith",
                author: $author.text().trim(),
                url: fullUrl
            });
        }
    });

    return results;
}

/**
 * Search MTG Card Builder
 */
async function searchMtgCardBuilder(query: string): Promise<CustomCard[]> {
    const url = "https://mtgcardbuilder.com/wp-admin/admin-ajax.php";

    const params = new URLSearchParams();
    params.append('search', query);
    params.append('order', 'recent');
    params.append('nsfw', '0');
    params.append('other', '0');
    params.append('cpage', '1');
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

    return results;
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

/**
 * Perform a search for a single query (cached or fresh)
 */
async function performSearch(query: string, sourceFilter?: string): Promise<MpcCard[]> {
    const normalizedQuery = query.toLowerCase().trim();
    // Cache key includes source filter if present to distinguish partial vs full searches
    // v2: Bumped cache version to clear potentially poisoned empty results
    const cacheKey = `${normalizedQuery}:custom:${sourceFilter || 'all'}:v2`;

    // Check cache
    const cached = getCachedMpcSearch(cacheKey, "CUSTOM");
    if (cached) {
        return cached;
    }
    
    let cardsmithPromise: Promise<CustomCard[]> | undefined;
    let cardbuilderPromise: Promise<CustomCard[]> | undefined;

    if (!sourceFilter || sourceFilter === 'mtgcardsmith') {
        cardsmithPromise = wrappedSearchCardsmith(query);
    }
    
    if (!sourceFilter || sourceFilter === 'mtgcardbuilder') {
        cardbuilderPromise = wrappedSearchCardBuilder(query);
    }

    let cardsmithResults: CustomCard[] = [];
    let cardbuilderResults: CustomCard[] = [];
    let partialFailure = false;

    if (cardsmithPromise) {
        try {
            cardsmithResults = await cardsmithPromise;
        } catch (error) {
            console.error(`[CustomCards] Cardsmith search failed for "${query}":`, error);
            partialFailure = true;
        }
    }

    if (cardbuilderPromise) {
        try {
            cardbuilderResults = await cardbuilderPromise;
        } catch (error) {
            console.error(`[CustomCards] CardBuilder search failed for "${query}":`, error);
            partialFailure = true;
        }
    }

    const allResults = [...cardsmithResults, ...cardbuilderResults].map(mapToMpcCard);
    
    // Cache results ONLY if no partial failure occurred.
    // This prevents caching incomplete results (e.g. if one source timed out).
    if (!partialFailure) {
        cacheMpcSearch(cacheKey, "CUSTOM", allResults);
    }
    
    return allResults;
}

// Track background jobs
const activeJobs = new Set<string>();

/**
 * GET /api/custom/search
 * Single card search
 */
router.get("/search", async (req: Request, res: Response) => {
    const q = req.query.q as string;
    const source = req.query.source as string | undefined; // 'mtgcardsmith' or 'mtgcardbuilder'

    if (!q) {
        return res.status(400).json({ error: "Missing q parameter" });
    }

    try {
        const results = await performSearch(q, source);
        
        return res.json({
            object: "list",
            total_cards: results.length,
            data: results
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
        const cacheKey = `${normalizedQuery}:custom:${sourceFilter || 'all'}`;
        const cached = getCachedMpcSearch(cacheKey, "CUSTOM");
        
        if (cached) {
            results[query] = cached;
        } else {
            // Queue for background processing
            queued.push(query);
            
            // Start background job if not already running
            if (!activeJobs.has(cacheKey)) {
                activeJobs.add(cacheKey);
                performSearch(query, sourceFilter)
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
