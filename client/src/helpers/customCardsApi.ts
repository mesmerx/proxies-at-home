import axios from "axios";
import type { MpcAutofillCard } from "./mpcAutofillApi";
import { API_BASE } from "../constants";

export interface CustomCardsSearchResult {
    cards: MpcAutofillCard[];
    hasMoreCardsmith: boolean;
    hasMoreCardbuilder: boolean;
}

export type CardsmithSort = "newest" | "oldest" | "favorites";

export async function searchCustomCards(query: string, source?: string, page: number = 1, cardsmithSort?: CardsmithSort): Promise<CustomCardsSearchResult> {
    try {
        const response = await axios.get(`${API_BASE}/api/custom/search`, {
            params: {
                q: query,
                source,
                page: page > 1 ? page : undefined,
                sort: cardsmithSort && cardsmithSort !== "newest" ? cardsmithSort : undefined,
            }
        });

        return {
            cards: response.data.data as MpcAutofillCard[],
            hasMoreCardsmith: response.data.hasMoreCardsmith ?? false,
            hasMoreCardbuilder: response.data.hasMoreCardbuilder ?? false,
        };
    } catch (error) {
        console.error("Custom card search failed:", error);
        return { cards: [], hasMoreCardsmith: false, hasMoreCardbuilder: false };
    }
}

export async function batchSearchCustomCards(queries: string[]): Promise<Record<string, MpcAutofillCard[]>> {
    if (queries.length === 0) return {};

    try {
        const response = await axios.post(`${API_BASE}/api/custom/batch-search`, {
            queries
        });

        const results: Record<string, MpcAutofillCard[]> = {};

        // Server returns Record<string, MpcCard[]> which matches Record<string, MpcAutofillCard[]>
        const rawResults = response.data.results as Record<string, any[]>;

        for (const [query, cards] of Object.entries(rawResults)) {
            results[query] = cards as MpcAutofillCard[];
        }

        // Log queued items if any
        if (response.data.queued && response.data.queued.length > 0) {
            console.log(`[CustomCards] Queued ${response.data.queued.length} queries for background processing`);
        }

        return results;
    } catch (error) {
        console.error("Custom card batch search failed:", error);
        return {};
    }
}
