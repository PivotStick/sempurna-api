import { getQuestionsCollection } from "./db.js";
import { QUESTIONS, SPICY_QUESTIONS } from "./question-bank.js";

// Walk the bank with a stride coprime to its length: every question is
// visited exactly once per cycle, but never in file order.
const STRIDE = 53;

const dayBefore = (dateStr) => {
	const d = new Date(dateStr + "T00:00:00Z");
	d.setUTCDate(d.getUTCDate() - 1);
	return d.toISOString().slice(0, 10);
};

/**
 * Spicy mode à la Duolingo: once the streak (projected to include today)
 * reaches 5, the daily question turns intimate — and stays spicy for as long
 * as the flame lives. Miss a day, back to regular, earn it again. 🌶️
 * @param {{ streak?: number, lastCompletedDate?: string }} couple
 */
export function isSpicyDay(couple, todayStr) {
	return projectedStreak(couple, todayStr) >= 5;
}

/** The streak as it will be once today is completed. */
export function projectedStreak(couple, todayStr) {
	if (couple.lastCompletedDate === todayStr) return couple.streak || 0;
	if (couple.lastCompletedDate === dayBefore(todayStr)) return (couple.streak || 0) + 1;
	return 1;
}

/**
 * Pick the wording that fits the couple's situation. Entries: plain string,
 * or { ldr, met, notMet, together } — see question-bank.js.
 * `longDistance` defaults to true (that's who the bank was written for).
 */
export function resolveEntry(entry, couple) {
	if (typeof entry === "string") return entry;
	const longDistance = couple.longDistance !== false;
	if (!longDistance) {
		return entry.together ?? entry.met ?? entry.ldr ?? entry.notMet;
	}
	const base = couple.hasMet ? (entry.met ?? entry.ldr) : (entry.notMet ?? entry.met ?? entry.ldr);
	return base ?? entry.together;
}

/**
 * Get or create today's question for the couple (lazy upsert).
 * @param {object} couple full couple doc (streak fields drive spicy)
 * @param {string} todayStr YYYY-MM-DD (the requesting phone's local day)
 */
export async function getTodayQuestion(couple, todayStr) {
	const questions = await getQuestionsCollection();

	const existing = await questions.findOne({ coupleId: couple._id, date: todayStr });
	if (existing) return existing;

	const created = new Date(couple.createdAt);
	const daysSinceCreation = Math.max(0,
		Math.floor((new Date(todayStr + "T00:00:00Z").getTime() - created.getTime()) / 86_400_000));

	const spicy = isSpicyDay(couple, todayStr);
	const bank = spicy ? SPICY_QUESTIONS : QUESTIONS;
	const questionIndex = (daysSinceCreation * STRIDE) % bank.length;
	const questionText = resolveEntry(bank[questionIndex], couple);

	const doc = {
		coupleId: couple._id,
		date: todayStr,
		questionIndex,
		questionText,
		spicy,
		answers: {},
		comments: [],
		createdAt: new Date(),
	};
	await questions.insertOne(doc);
	return doc;
}

export async function submitAnswer(coupleId, date, userId, text) {
	const questions = await getQuestionsCollection();
	return questions.findOneAndUpdate(
		{ coupleId, date },
		{ $set: { [`answers.${userId}`]: { text, answeredAt: new Date() } } },
		{ returnDocument: "after" },
	);
}

// MARK: Reactions on answers (the pinned Q&A at the top of the chat)

export const ANSWER_REACTIONS = ["❤️", "😂", "😮", "🥺", "🔥"];

export async function toggleAnswerReaction(coupleId, date, userId, targetUserId, emoji) {
	const questions = await getQuestionsCollection();
	const key = `reactions.${userId}.${targetUserId}`;
	const update = emoji && ANSWER_REACTIONS.includes(emoji)
		? { $set: { [key]: emoji } }
		: { $unset: { [key]: "" } };
	return questions.findOneAndUpdate({ coupleId, date }, update, { returnDocument: "after" });
}

// MARK: Chat (unlocked once both answered — enforced by the routes)

export async function addMessage(coupleId, date, userId, text, gif = null) {
	const questions = await getQuestionsCollection();
	const message = { userId, text: text || "", createdAt: new Date(), read: false, reactions: {} };
	// GIFs are referenced by URL only (Giphy) — no image bytes stored.
	if (gif && gif.url) message.gif = { url: gif.url, width: gif.width || 0, height: gif.height || 0 };
	return questions.findOneAndUpdate(
		{ coupleId, date },
		{ $push: { comments: message } },
		{ returnDocument: "after" },
	);
}

export async function toggleMessageReaction(coupleId, date, index, userId, emoji) {
	const questions = await getQuestionsCollection();
	const doc = await questions.findOne({ coupleId, date });
	if (!doc || !Array.isArray(doc.comments) || !(index >= 0 && index < doc.comments.length)) return null;

	const key = `comments.${index}.reactions.${userId}`;
	const current = doc.comments[index].reactions?.[userId];
	const update = emoji && emoji !== current && ANSWER_REACTIONS.includes(emoji)
		? { $set: { [key]: emoji } }
		: { $unset: { [key]: "" } };   // same emoji again (or null) = remove
	return questions.findOneAndUpdate({ coupleId, date }, update, { returnDocument: "after" });
}

export async function deleteMessage(coupleId, date, index, userId) {
	const questions = await getQuestionsCollection();
	const doc = await questions.findOne({ coupleId, date });
	if (!doc || !Array.isArray(doc.comments) || !(index >= 0 && index < doc.comments.length)) return null;
	if (doc.comments[index].userId !== userId) return null;
	const comments = doc.comments.slice();
	comments.splice(index, 1);
	return questions.findOneAndUpdate(
		{ coupleId, date },
		{ $set: { comments } },
		{ returnDocument: "after" },
	);
}

/** One specific day (for the streak calendar's day view). */
export async function getQuestionByDate(coupleId, date) {
	return (await getQuestionsCollection()).findOne({ coupleId, date });
}

/**
 * The whole history, light projection — enough to paint the calendar.
 * @returns [{date, spicy, answers}] sorted by date ascending
 */
export async function listHistory(coupleId) {
	return (await getQuestionsCollection())
		.find({ coupleId }, { projection: { date: 1, spicy: 1, answers: 1 } })
		.sort({ date: 1 })
		.toArray();
}

/** Mark the partner's messages as read (called when the chat is fetched). */
export async function markMessagesRead(coupleId, date, readerId) {
	const questions = await getQuestionsCollection();
	await questions.updateOne(
		{ coupleId, date },
		{ $set: { "comments.$[c].read": true } },
		{ arrayFilters: [{ "c.userId": { $ne: readerId }, "c.read": { $ne: true } }] },
	).catch(() => {}); // arrayFilters needs the path to exist — fine to skip when no comments
}
