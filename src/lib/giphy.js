// Giphy GIF proxy — keeps the API key server-side. No-ops gracefully if unconfigured.
// Get a free key at https://developers.giphy.com → set GIPHY_API_KEY.
const KEY = process.env.GIPHY_API_KEY;
const RATING = "pg-13";

export function isConfigured() {
	return !!KEY;
}

async function giphy(path, params = {}) {
	const url = new URL(`https://api.giphy.com/v1/${path}`);
	url.searchParams.set("api_key", KEY);
	url.searchParams.set("rating", RATING);
	url.searchParams.set("bundle", "messaging_non_clips");
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
	const res = await fetch(url);
	if (!res.ok) throw new Error(`giphy ${path} ${res.status}`);
	return res.json();
}

function normalize(items) {
	return (items || []).map((g) => {
		const im = g.images || {};
		const main = im.fixed_width || im.downsized || im.original || {};
		const still = im.fixed_width_still || main;
		return {
			id: g.id,
			url: main.url,
			preview: still.url || main.url,
			width: parseInt(main.width, 10) || 0,
			height: parseInt(main.height, 10) || 0,
		};
	}).filter((g) => g.url);
}

export async function featured(limit = 24) {
	if (!KEY) return [];
	const data = await giphy("gifs/trending", { limit });
	return normalize(data.data);
}

export async function search(q, limit = 30) {
	if (!KEY) return [];
	const data = await giphy("gifs/search", { q, limit });
	return normalize(data.data);
}

export async function categories() {
	if (!KEY) return [];
	const data = await giphy("gifs/categories", {});
	return (data.data || []).map((c) => ({
		name: c.name,
		searchTerm: c.name_encoded || c.name,
		image: c.gif?.images?.fixed_width_small?.url || c.gif?.images?.fixed_width?.url || "",
	})).filter((c) => c.image);
}
