import { MongoClient } from "mongodb";

/** @type {MongoClient} */
let client;
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

export async function getDb() {
	if (!appDb) {
		const c = await getClient();
		appDb = c.db("sempurna");
	}
	return appDb;
}

// Sempurna owns its users — no shared pivotauth here. Registration is capped
// at two accounts (see auth.js): it's a couple app, the door closes itself.
export async function getUsers() {
	return (await getDb()).collection("users");
}
export async function getSessions() {
	return (await getDb()).collection("sessions");
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
export async function getQuestionsCollection() {
	return (await getDb()).collection("daily_questions");
}
export async function getJokesCollection() {
	return (await getDb()).collection("jokes");
}
