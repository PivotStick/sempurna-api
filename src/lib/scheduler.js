// The Duolingo of love: a daily reminder to answer the question, sent at
// 20:00 in each partner's own timezone (from their presence, so it follows
// them when they travel). Once per person per couple-day, only if they
// haven't answered yet.
import { getCouplesCollection, getQuestionsCollection, getPresencesCollection, getUsers } from "./db.js";
import { coupleDayString } from "./couple.js";
import { notifyUser } from "./push.js";
import { isConfigured } from "./apns.js";

const REMINDER_HOUR = Number(process.env.REMINDER_HOUR || 20);
const TICK_MS = 10 * 60 * 1000;

function localHour(timeZone, now) {
	try {
		return Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "numeric", hour12: false }).format(now));
	} catch {
		return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "numeric", hour12: false }).format(now));
	}
}

/** One pass — exported so it can be tested with a forced `now`. */
export async function runReminderTick(now = new Date()) {
	if (!isConfigured()) return;

	const couples = await (await getCouplesCollection()).find({ "users.1": { $exists: true } }).toArray();
	const users = await getUsers();
	const presences = await getPresencesCollection();
	const questions = await getQuestionsCollection();

	for (const couple of couples) {
		const todayStr = coupleDayString(couple, now);
		const question = await questions.findOne({ coupleId: couple._id, date: todayStr });
		const answers = question?.answers || {};

		for (const entry of couple.users) {
			const userId = entry.userId;
			if (answers[userId.toString()]) continue;   // already answered today

			const user = await users.findOne({ _id: userId });
			if (!user || user.notificationsMuted) continue;
			if (user.lastQuestionReminder === todayStr) continue;   // already reminded today

			const presence = await presences.findOne({ userId });
			const tz = presence?.timeZoneID || couple.dayTimeZone || "Europe/Paris";
			if (localHour(tz, now) !== REMINDER_HOUR) continue;

			const partnerEntry = couple.users.find((u) => !u.userId.equals(userId));
			const partner = partnerEntry ? await users.findOne({ _id: partnerEntry.userId }) : null;
			const partnerAnswered = partnerEntry && !!answers[partnerEntry.userId.toString()];

			const message = partnerAnswered
				? { title: `${partner?.username || "Your love"} answered today's question 👀`,
					body: "Answer before midnight to reveal it — and keep the flame alive 🔥" }
				: (couple.streak || 0) > 0
					? { title: `🔥 ${couple.streak}-day streak on the line`,
						body: "Today's question is still waiting for you two 💌" }
					: { title: "Today's question is waiting 💌",
						body: "One little answer before bed?" };

			await users.updateOne({ _id: userId }, { $set: { lastQuestionReminder: todayStr } });
			await notifyUser(userId, { ...message, data: { kind: "question", date: todayStr } });
			console.log(`[reminder] ${todayStr} → ${user.username}`);
		}
	}
}

export function startScheduler() {
	if (!isConfigured()) {
		console.log("[reminder] APNs not configured — daily reminders disabled");
		return;
	}
	setInterval(() => runReminderTick().catch((e) => console.log("[reminder] tick failed:", e.message)), TICK_MS);
	console.log(`[reminder] scheduler on — question nudge at ${REMINDER_HOUR}:00 local, tick every ${TICK_MS / 60000}min`);
}
