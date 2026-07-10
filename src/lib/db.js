import { MongoClient } from "mongodb";

/** @type {MongoClient} */
let client;
/** @type {import('mongodb').Db} */
let authDb;
/** @type {import('mongodb').Db} */
let appDb;

async function getClient() {
	if (!client) {
		if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not set");
		client = new MongoClient(process.env.MONGO_URI);
		await client.connect();
	}
	return client;
}

export async function getAuthDb() {
	if (!authDb) {
		const c = await getClient();
		authDb = c.db("pivotauth");
	}
	return authDb;
}

export async function getDb() {
	if (!appDb) {
		const c = await getClient();
		appDb = c.db("sempurna");
	}
	return appDb;
}

// Auth collections (shared with pivotass-anki / pixel-garden)
export async function getUsers() {
	return (await getAuthDb()).collection("users");
}
export async function getSessions() {
	return (await getAuthDb()).collection("sessions");
}

// App collections
export async function getCouplesCollection() {
	return (await getDb()).collection("couples");
}
export async function getMomentsCollection() {
	return (await getDb()).collection("moments");
}
export async function getPingsCollection() {
	return (await getDb()).collection("pings");
}
export async function getPresencesCollection() {
	return (await getDb()).collection("presences");
}
export async function getWordsCollection() {
	return (await getDb()).collection("words");
}
