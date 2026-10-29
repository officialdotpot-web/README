import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { existsSync } from "fs";
import { spawn } from "child_process";
import {
    TikTokLiveConnection,
    WebcastEvent
} from "tiktok-live-connector";

const app = express();

app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// ADMIN / DASHBOARD STATE
// ============================================================

const ADMIN_TOKEN =
    process.env.ADMIN_TOKEN ||
    crypto.randomBytes(24).toString("hex");

const CONTEST_DURATION = 300;

const contestState = {
    id: 0,
    running: false,
    acceptingSubmissions: false,
    phase: "WAITING",
    timeRemaining: 0,
    duration: CONTEST_DURATION,
    startedAt: null,
    endedAt: null,
    clearedAt: null,
    clearedQueue: []
};

const robloxState = {
    queue: [],
    active: [],
    contestRunning: false,
    phase: "WAITING",
    timeRemaining: 0,
    lastHeartbeat: 0
};

const contestantRecords = new Map();
const eventLog = [];
let lastContestSummary = null;

// Every admin/gift action is kept here until Roblox can actually
// apply it. This prevents a boost from being lost during the tiny
// window between Node sending a contestant and Roblox adding it.


function normalizeUsername(username) {
    return String(username || "")
        .trim()
        .replace(/^@+/, "")
        .toLowerCase();
}

function recordFor(username) {
    const key = normalizeUsername(username);
    return contestantRecords.get(key) || null;
}

function ensureRecord(username, extra = {}) {
    const clean = String(username || "").trim().replace(/^@+/, "");
    const key = normalizeUsername(clean);

    if (!key) return null;

    let record = contestantRecords.get(key);

    if (!record) {
        record = {
            username: clean,
            tiktokUser: null,
            submittedAt: Date.now(),
            status: "node_queue",
            gifts: [],
            effects: [],
            lastAction: null,
            ...extra
        };
        contestantRecords.set(key, record);
    } else {
        Object.assign(record, extra);
    }

    return record;
}

function logEvent(type, message, data = {}) {
    const event = {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        type,
        message,
        ...data
    };

    eventLog.unshift(event);

    if (eventLog.length > 300) {
        eventLog.length = 300;
    }

    return event;
}

function boostRank(tier) {
    return {
        SKIP: 100,
        GLOW: 200,
        GIANT: 300,
        SUPER: 400,
        LEGENDARY: 500
    }[String(tier || "").toUpperCase()] || 0;
}

function isInRobloxQueue(username) {
    const key = normalizeUsername(username);

    return robloxState.queue.some(item =>
        normalizeUsername(item?.username) === key
    );
}

function isActiveInRoblox(username) {
    const key = normalizeUsername(username);

    return robloxState.active.some(item =>
        normalizeUsername(item?.username) === key
    );
}

function queueBoost(username, tier, sender = "SYSTEM", source = "gift") {
    const clean = String(username || "").trim().replace(/^@+/, "");
    const normalizedTier = String(tier || "").toUpperCase();

    if (!clean || !normalizedTier) return false;

    const rank = boostRank(normalizedTier);
    if (!rank) return false;

    // Keep only the strongest pending visual boost for a contestant.
    // This prevents GLOW arriving after GIANT from downgrading it.
    for (let i = pendingBoosts.length - 1; i >= 0; i--) {
        if (normalizeUsername(pendingBoosts[i].username) === normalizeUsername(clean)) {
            if (boostRank(pendingBoosts[i].tier) >= rank) {
                return true;
            }
            pendingBoosts.splice(i, 1);
        }
    }

    pendingBoosts.push({
        id: crypto.randomUUID(),
        username: clean,
        tier: normalizedTier,
        sender,
        source,
        createdAt: Date.now()
    });

    const record = ensureRecord(clean);
    if (record) {
        record.effects.push({
            tier: normalizedTier,
            sender,
            source,
            queuedAt: Date.now(),
            applied: false
        });
        record.lastAction = `${normalizedTier} queued`;
    }

    logEvent(
        source === "admin" ? "ADMIN_ACTION" : "BOOST_QUEUED",
        `@${clean} -> ${normalizedTier}`,
        {
            username: clean,
            tier: normalizedTier,
            sender,
            source
        }
    );

    return true;
}

function takePendingBoostFor(username) {
    const key = normalizeUsername(username);
    let bestIndex = -1;
    let bestRank = -1;

    for (let i = 0; i < pendingBoosts.length; i++) {
        const boost = pendingBoosts[i];

        if (normalizeUsername(boost.username) !== key) {
            continue;
        }

        const rank = boostRank(boost.tier);

        if (rank > bestRank) {
            bestRank = rank;
            bestIndex = i;
        }
    }

    if (bestIndex === -1) {
        return null;
    }

    const [boost] = pendingBoosts.splice(bestIndex, 1);
    return boost;
}

function moveContestantToFront(username, source = "gift", sender = null) {
    if (!username) return false;

    const key = normalizeUsername(username);

    const index = contestantQueue.findIndex(
        name => normalizeUsername(name) === key
    );

    if (index === -1) {
        return false;
    }

    const [contestant] = contestantQueue.splice(index, 1);
    // Rose moves the contestant to #1, #2 or #3 (whichever is available).
    // This keeps the entry in the queue and avoids the old unconditional
    // jump-to-front behavior causing confusing queue movement.
    const targetPosition = Math.min(
        contestantQueue.length + 1,
        1 + Math.floor(Math.random() * 3)
    );
    contestantQueue.splice(targetPosition - 1, 0, contestant);

    const record = ensureRecord(contestant);
    if (record) {
        record.status = "node_queue";
        record.lastAction = `SKIP -> #${targetPosition}`;
    }

    logEvent(
        source === "admin" ? "ADMIN_SKIP" : "SKIP",
        `@${contestant} moved to #${targetPosition} in the incoming queue`,
        {
            username: contestant,
            sender,
            source
        }
    );

    console.log(
        `[${source === "admin" ? "Admin" : "Gift"}] SKIP applied: @${contestant} moved to #${targetPosition}.`
    );

    return true;
}

function applySkip(username, sender = null, source = "gift") {
    if (moveContestantToFront(username, source, sender)) {
        return "node_queue";
    }

    // Already handed to Roblox: let Roblox move its real waiting
    // queue entry to #1. If it is between the two queues, keeping
    // the pending action is intentional; it will be delivered later.
    if (isInRobloxQueue(username)) {
        queueBoost(username, "SKIP", sender || "SYSTEM", source);
        return "roblox_queue";
    }

    if (isActiveInRoblox(username)) {
        const record = ensureRecord(username);
        if (record) {
            record.lastAction = "SKIP ignored - already active";
        }

        logEvent(
            "SKIP_IGNORED",
            `@${username} is already active; no waiting-queue position to change`,
            { username, sender, source }
        );

        return "active";
    }

    queueBoost(username, "SKIP", sender || "SYSTEM", source);
    return "pending";
}

function clearNodeQueue(reason = "clear") {
    const cleared = [...contestantQueue];

    for (const username of cleared) {
        const record = ensureRecord(username);
        if (record) {
            record.status = "cleared";
            record.lastAction = `cleared (${reason})`;
        }
    }

    contestantQueue.length = 0;
    pendingBoosts.length = 0;

    return cleared;
}

function archiveCurrentContest() {
    if (!contestState.startedAt && contestantRecords.size === 0) {
        return;
    }

    lastContestSummary = {
        ...contestState,
        clearedQueue: [...contestState.clearedQueue],
        contestants: [...contestantRecords.values()].map(record => ({
            ...record,
            gifts: [...record.gifts],
            effects: [...record.effects]
        })),
        events: [...eventLog]
    };
}

function startNewContest() {
    archiveCurrentContest();

    // Preserve incoming contestants and pending gifts across round boundaries.
    // Reset only per-viewer rate limits and per-contest reporting.
    userCooldowns.clear();
    lastSubmission.clear();

    const waitingNames = [...contestantQueue];
    contestantRecords.clear();
    eventLog.length = 0;
    for (const username of waitingNames) {
        ensureRecord(username, { status: "node_queue" });
    }

    contestState.id += 1;
    contestState.running = true;
    contestState.acceptingSubmissions = true;
    contestState.phase = "STARTING";
    contestState.timeRemaining = CONTEST_DURATION;
    contestState.duration = CONTEST_DURATION;
    contestState.startedAt = Date.now();
    contestState.endedAt = null;
    contestState.clearedAt = null;
    contestState.clearedQueue = [];

    logEvent("CONTEST_START", `Contest #${contestState.id} started`, {
        contestId: contestState.id
    });
}

// ============================================================
// CLOUDFLARE BRIDGE
// ============================================================


function findCloudflared() {
    const candidates = [
        process.env.CLOUDFLARED_PATH,
        path.join(__dirname, "..", "cloudflared.exe"),
        path.join(__dirname, "tools", "cloudflared.exe"),
        "C:\\Program Files\\cloudflared\\cloudflared.exe",
        "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe"
    ].filter(Boolean);

    const found = candidates.find(candidate => existsSync(candidate));

    if (!found) {
if (process.env.RENDER) return "/bin/true";
throw new Error("cloudflared.exe not found. Put cloudflared.exe beside Start Avatar Rating Studio.bat.");
        );
    }

    return found;
}


const CLOUDFLARED_PATH = findCloudflared();

let cloudflaredProcess = null;

const bridgeState = {
    running: false,
    url: null,
    startedAt: null,
    error: null
};
function startCloudflareBridge() {
    if (cloudflaredProcess) {
        return {
            success: false,
            error: "Cloudflare bridge is already running.",
            url: bridgeState.url
        };
    }

    bridgeState.running = false;
    bridgeState.url = null;
    bridgeState.error = null;

    console.log("[Cloudflare] Starting tunnel...");

    cloudflaredProcess = spawn(
        CLOUDFLARED_PATH,
        [
            "tunnel",
            "--protocol",
            "http2",
            "--url",
            "http://localhost:3000"
        ],
        {
            windowsHide: true,
            shell: false
        }
    );

    const handleOutput = data => {
        const output = data.toString();

        console.log(`[Cloudflare] ${output.trim()}`);

        const match = output.match(
            /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/
        );

        if (match && !bridgeState.url) {
            bridgeState.url = match[0];
            bridgeState.running = true;
            bridgeState.startedAt = Date.now();

            console.log(
                `[Cloudflare] Bridge URL: ${bridgeState.url}`
            );

            logEvent(
                "BRIDGE_STARTED",
                `Cloudflare bridge started: ${bridgeState.url}`,
                {
                    url: bridgeState.url
                }
            );
        }
    };

    cloudflaredProcess.stdout.on(
        "data",
        handleOutput
    );

    cloudflaredProcess.stderr.on(
        "data",
        handleOutput
    );

    cloudflaredProcess.on(
        "error",
        error => {
            console.error(
                "[Cloudflare] Process error:",
                error
            );

            bridgeState.running = false;
            bridgeState.error = error.message;
            cloudflaredProcess = null;
        }
    );

    cloudflaredProcess.on(
        "close",
        code => {
            console.log(
                `[Cloudflare] Process exited with code ${code}`
            );

            bridgeState.running = false;

            if (!bridgeState.error && code !== 0) {
                bridgeState.error =
                    `cloudflared exited with code ${code}`;
            }

            cloudflaredProcess = null;
        }
    );

    return {
        success: true,
        message: "Cloudflare bridge is starting."
    };
}

function stopCloudflareBridge() {
    if (!cloudflaredProcess) {
        bridgeState.running = false;
        bridgeState.url = null;

        return {
            success: true,
            message: "Cloudflare bridge was not running."
        };
    }

    console.log("[Cloudflare] Stopping tunnel...");

    cloudflaredProcess.kill();

    cloudflaredProcess = null;

    bridgeState.running = false;
    bridgeState.url = null;
    bridgeState.startedAt = null;

    logEvent(
        "BRIDGE_STOPPED",
        "Cloudflare bridge stopped"
    );

    return {
        success: true,
        message: "Cloudflare bridge stopped."
    };
}

function endContest(clearedQueue = []) {
    // The Roblox side sends its waiting queue snapshot here. It is not a
    // "cleared" list: those contestants must survive into the next round.
    const waitingRoblox = Array.isArray(clearedQueue)
        ? clearedQueue.map(item => item?.username || item).filter(Boolean)
        : [];

    contestState.running = false;
    contestState.acceptingSubmissions = false;
    contestState.phase = "ENDED";
    contestState.timeRemaining = 0;
    contestState.endedAt = Date.now();
    contestState.clearedAt = null;
    contestState.clearedQueue = [];

    for (const username of [...contestantQueue, ...waitingRoblox]) {
        ensureRecord(username);
    }

    logEvent(
        "CONTEST_END",
        `Contest #${contestState.id} ended; waiting contestants preserved for the next round`,
        {
            contestId: contestState.id,
            preservedNodeCount: contestantQueue.length,
            preservedRobloxCount: waitingRoblox.length
        }
    );
}

function updateRecordStatuses() {
    const nodeSet = new Set(
        contestantQueue.map(username => normalizeUsername(username))
    );

    const robloxSet = new Set(
        robloxState.queue.map(item => normalizeUsername(item?.username))
    );

    const activeSet = new Set(
        robloxState.active.map(item => normalizeUsername(item?.username))
    );

    for (const record of contestantRecords.values()) {
        const key = normalizeUsername(record.username);

        if (activeSet.has(key)) {
            record.status = "active";
        } else if (robloxSet.has(key)) {
            record.status = "roblox_queue";
        } else if (nodeSet.has(key)) {
            record.status = "node_queue";
        } else if (record.status !== "cleared") {
            record.status = "processed";
        }
    }
}

function adminTokenOk(req) {
    return req.get("x-admin-token") === ADMIN_TOKEN;
}

function requireAdmin(req, res, next) {
    if (!adminTokenOk(req)) {
        return res.status(401).json({
            success: false,
            error: "Invalid admin token"
        });
    }

    next();
}


app.get("/test-gift", (req, res) => {
    const username = String(req.query.username || "FakePlayer")
        .trim()
        .replace(/^@+/, "");

    const tier = String(req.query.tier || "GIANT").trim();

    pendingBoosts.push({
        username,
        tier,
        sender: "TEST"
    });

    console.log(
        `[TEST] Gift queued: @${username} -> ${tier}`
    );

    res.json({
        success: true,
        username,
        tier
    });
});

const PORT = Number(process.env.PORT || 3000);
const TIKTOK_USERNAME = String(process.env.TIKTOK_USERNAME || "imtheonebeach")
    .trim()
    .replace(/^@+/, "") || "imtheonebeach";
const TEST_MODE = false;
const GIFTS_ENABLED = true;
// ============================================================
// QUEUE
// ============================================================

const contestantQueue = [];


// ============================================================
// TIKTOK USER COOLDOWN
// ============================================================
// The same TikTok viewer can submit ANY Roblox username once
// every 5 seconds. There is NO once-per-contest restriction
// and NO per-Roblox-username cooldown.

const userCooldowns = new Map();
const RATE_COOLDOWN = 5 * 1000; // 5 seconds

// ============================================================
// GIFT BOOSTS
// ============================================================
// When a TikTok viewer sends a gift, we need to know which
// Roblox username to apply it to. lastSubmission remembers the
// most recent successful !rate/name submission per TikTok
// viewer, so a gift sent afterwards knows who to boost. Entries
// expire after LAST_SUBMISSION_TTL so a gift sent long after
// someone's last submission doesn't attach to something stale.

const lastSubmission = new Map(); // tiktokKey -> { robloxUsername, timestamp }

const LAST_SUBMISSION_TTL = 10 * 60 * 1000; // 10 minutes

// FIFO of boosts waiting to be picked up by Roblox via /next-boost.
const pendingBoosts = [];

// Ordered ascending by diamond cost. A gift's total value
// (diamondCount * repeatCount) is matched against the HIGHEST
// tier whose minDiamonds it clears. Using diamond cost instead
// of hardcoded gift names means this keeps working even if
// TikTok's gift catalog/names change — tune freely.

const GIFT_TIERS = [
    { minDiamonds: 1,   tier: "SKIP" },
    { minDiamonds: 5,   tier: "GLOW" },
    { minDiamonds: 20,  tier: "GIANT" },
    { minDiamonds: 50,  tier: "SUPER" },
    { minDiamonds: 100, tier: "LEGENDARY" },
];

function getGiftTier(totalDiamonds) {

    let matched = null;

    for (const entry of GIFT_TIERS) {

        if (totalDiamonds >= entry.minDiamonds) {

            matched = entry.tier;

        }

    }

    return matched;

}


// ============================================================
// ADD CONTESTANT
// ============================================================

function addContestant(username, metadata = {}) {

    if (
        username === undefined ||
        username === null
    ) {
        return false;
    }

    username =
        String(username)
            .trim()
            .replace(/^@+/, "");

    if (!username) {
        return false;
    }

    // Duplicate Roblox usernames are allowed.
    contestantQueue.push(username);

    const record = ensureRecord(username, {
        tiktokUser: metadata.tiktokUser ?? null,
        submittedAt: Date.now(),
        status: "node_queue"
    });

    if (record) {
        record.lastAction = "submitted";
    }

    logEvent(
        "SUBMISSION",
        `@${username} entered the queue`,
        {
            username,
            tiktokUser: metadata.tiktokUser ?? null
        }
    );

    console.log(
        `[Bridge] Added contestant: @${username}`
    );

    console.log(
        `[Bridge] Queue size: ${contestantQueue.length}`
    );

    return true;
}

// ============================================================
// RESET CONTEST
// ============================================================
// FIX: now also clears the queue, the resubmit-cooldown map, AND
// oldSubmissionGate — not just the old anti-spam set. This
// guarantees a brand-new contest always starts fully clean, and
// that every viewer regains their one submission for the new
// contest, regardless of whether the Roblox side remembers to
// call /clear-queue separately.

function resetContestSubmissions() {
    startNewContest();

    console.log(
        `[Contest] Contest #${contestState.id} started (queue + 5s submission cooldown reset).`
    );
}

// ============================================================
// EXTRACT TIKTOK USERNAME
// ============================================================

function getTikTokUsername(data) {

    return (
        data?.user?.displayId ??
        data?.user?.uniqueId ??
        data?.user?.unique_id ??
        data?.user?.unique_id_str ??
        data?.displayId ??
        data?.uniqueId ??
        data?.unique_id ??
        data?.unique_id_str ??
        null
    );
}
function getGiftUsername(data) {

    return (
        data?.user?.displayId ??
        data?.user?.uniqueId ??
        data?.user?.unique_id ??
        data?.user?.unique_id_str ??
        data?.displayId ??
        data?.uniqueId ??
        data?.unique_id ??
        data?.unique_id_str ??
        null
    );

}

// ============================================================
// EXTRACT COMMENT
// ============================================================

function getTikTokComment(data) {

    const possibleComments = [

        data?.comment,

        data?.text,

        data?.message,

        data?.content,

        data?.user?.comment,

        data?.chatMessage,

        data?.message?.content

    ];

    for (
        const value of possibleComments
    ) {

        if (
            typeof value === "string" &&
            value.trim() !== ""
        ) {

            return value.trim();

        }
    }

    return null;
}

// ============================================================
// EXTRACT GIFT FIELDS
// ============================================================
// tiktok-live-connector's exact field shape has moved around
// between versions (top-level vs nested under giftDetails), so
// these fall back through both like the extractors above.



function getGiftName(data) {

    return (
        data?.gift?.name ??
        data?.giftDetails?.giftName ??
        data?.giftName ??
        data?.describe ??
        data?.giftDetails?.name ??
        "Unknown Gift"
    );

}

function getGiftDiamondCount(data) {

    return (
        data?.gift?.diamondCount ??
        data?.giftDetails?.diamondCount ??
        data?.diamondCount ??
        data?.giftDetails?.diamond_count ??
        data?.diamond_count ??
        0
    );

}

function getGiftRepeatCount(data) {

    return data?.repeatCount ?? 1;

}

function getGiftRepeatEnd(data) {

    // Non-streakable gifts may omit this field entirely.
    // Treat "missing" as "already final" so single gifts aren't
    // dropped waiting for an end-of-streak event that never comes.
    if (data?.repeatEnd === undefined) {
        return true;
    }

    return !!data?.repeatEnd;

}

// ============================================================
// TIKTOK CONNECTION
// ============================================================

let tiktokConnection = null;

async function startTikTok() {

    console.log(
        `[TikTok] Connecting to @${TIKTOK_USERNAME}...`
    );

    tiktokConnection =
        new TikTokLiveConnection(
            TIKTOK_USERNAME,
            {
                processInitialData: false,
                fetchRoomInfoOnConnect: true
            }
        );

    // ========================================================
    // CHAT
    // ========================================================

    tiktokConnection.on(
        WebcastEvent.CHAT,
        data => {

            console.log("[TikTok] CHAT EVENT RECEIVED");

            const tiktokUsername =
                getTikTokUsername(data);

            const comment =
                getTikTokComment(data);

            if (!tiktokUsername || !comment) {
                return;
            }

            console.log(
                `[TikTok] @${tiktokUsername}: ${comment}`
            );

            // ====================================================
            // ANTI-SPAM (chat rate throttle)
            // ====================================================

            const tiktokKey =
                String(tiktokUsername).toLowerCase();

            const now =
                Date.now();

            const lastUserSubmission =
                userCooldowns.get(tiktokKey);

            if (
                lastUserSubmission &&
                now - lastUserSubmission < RATE_COOLDOWN
            ) {

                const remaining =
                    Math.ceil(
                        (
                            RATE_COOLDOWN -
                            (now - lastUserSubmission)
                        ) / 1000
                    );

                console.log(
                    `[AntiSpam] @${tiktokUsername} on cooldown (${remaining}s left).`
                );

                return;
            }
            // A viewer may submit again after the 5-second cooldown.




            // ====================================================
            // PARSE ROBLOX USERNAME
            // ====================================================

            let robloxUsername = null;

            const trimmed =
                comment.trim();

            // Supports:
            // !rate Builderman
            // !rate @Builderman
            // Builderman
            // @Builderman

            if (
                trimmed.toLowerCase().startsWith("!rate")
            ) {

                robloxUsername =
                    trimmed
                        .slice(5)
                        .trim();

            } else {

                // Plain username mode
                robloxUsername =
                    trimmed;

            }

            robloxUsername =
                String(
                    robloxUsername || ""
                )
                    .trim()
                    .replace(/^@+/, "");

            // ====================================================
            // VALIDATE ROBLOX USERNAME
            // ====================================================

            if (
                !robloxUsername ||
                robloxUsername.length > 20 ||
                !/^[A-Za-z0-9_]+$/.test(robloxUsername)
            ) {

                console.log(
                    `[AntiSpam] Invalid Roblox username from @${tiktokUsername}: ${comment}`
                );

                return;
            }


            // ====================================================
            // ADD TO QUEUE
            // ====================================================

            const added =
                addContestant(
                    robloxUsername,
                    {
                        tiktokUser: tiktokUsername
                    }
                );

            if (!added) {
                return;
            }

            // ====================================================
            // RECORD COOLDOWNS / MARK VIEWER AS SUBMITTED
            // ====================================================

            userCooldowns.set(
                tiktokKey,
                now
            );

  




            // ====================================================
            // REMEMBER LAST SUBMISSION FOR GIFTS
            // ====================================================

            lastSubmission.set(
                tiktokKey,
                {
                    robloxUsername:
                        robloxUsername,

                    timestamp:
                        now
                }
            );

            console.log(
                `[TikTok] @${tiktokUsername} submitted Roblox player @${robloxUsername}`
            );

        }
    );

    // ========================================================
    // GIFT
    // ========================================================

tiktokConnection.on(
    WebcastEvent.GIFT,
    data => {

        if (!GIFTS_ENABLED) {
            return;
        }

        console.log(
            "[TikTok] 🎁 GIFT EVENT RECEIVED"
        );

        console.log(
            "[TikTok] 🎁 RAW DATA:",
            JSON.stringify(data, null, 2)
        );

            const giftName =
                getGiftName(data);

            const tiktokUsername =
                getGiftUsername(data);

            const diamondCount =
                Number(
                    getGiftDiamondCount(data)
                ) || 0;

            const repeatCount =
                Number(
                    getGiftRepeatCount(data)
                ) || 1;

            const repeatEnd =
                getGiftRepeatEnd(data);

            console.log(
                `[TikTok] 🎁 @${tiktokUsername ?? "unknown"} sent `
                    + `${giftName} x${repeatCount} `
                    + `(${diamondCount} diamonds each, repeatEnd=${repeatEnd})`
            );

            // Wait until a gift streak finishes.
            if (!repeatEnd) {
                return;
            }

            if (!tiktokUsername) {

                console.log(
                    "[Gift] Could not identify TikTok sender."
                );

                return;
            }

            const totalDiamonds =
                diamondCount * repeatCount;

            if (totalDiamonds <= 0) {

                console.log(
                    `[Gift] ${giftName} has no usable diamond value.`
                );

                return;
            }

            const tier =
                getGiftTier(
                    totalDiamonds
                );

            if (!tier) {
                return;
            }

            // =====================================================
            // FIND LAST ROBLOX SUBMISSION
            // =====================================================

            const tiktokKey =
                String(
                    tiktokUsername
                ).toLowerCase();

            const submission =
                lastSubmission.get(
                    tiktokKey
                );

            if (
                !submission ||
                Date.now() -
                    submission.timestamp >
                    LAST_SUBMISSION_TTL
            ) {

                console.log(
                    `[Gift] ❌ @${tiktokUsername} sent ${giftName}, `
                        + `but has no recent Roblox submission.`
                );

                return;
            }

            const robloxUsername =
                submission.robloxUsername;

            // =====================================================
            // 🌹 ROSE = SKIP
            // =====================================================

if (tier === "SKIP") {

                const location =
                    applySkip(
                        robloxUsername,
                        tiktokUsername,
                        "gift"
                    );

                const record =
                    ensureRecord(
                        robloxUsername,
                        {
                            tiktokUser: tiktokUsername
                        }
                    );

                if (record) {
                    record.gifts.push({
                        giftName,
                        diamondCount,
                        repeatCount,
                        totalDiamonds,
                        tier,
                        sender: tiktokUsername,
                        timestamp: Date.now(),
                        action: `SKIP -> ${location}`
                    });
                    record.lastAction = `SKIP -> ${location}`;
                }

                logEvent(
                    "GIFT",
                    `@${tiktokUsername} sent ${giftName} (${totalDiamonds} diamonds) -> @${robloxUsername} = SKIP`,
                    {
                        username: robloxUsername,
                        sender: tiktokUsername,
                        giftName,
                        diamondCount,
                        repeatCount,
                        totalDiamonds,
                        tier,
                        action: location
                    }
                );

                return;
            }

            // =====================================================
            // OTHER BOOSTS

            queueBoost(
                robloxUsername,
                tier,
                tiktokUsername,
                "gift"
            );

            const giftRecord =
                ensureRecord(
                    robloxUsername,
                    {
                        tiktokUser: tiktokUsername
                    }
                );

            if (giftRecord) {
                giftRecord.gifts.push({
                    giftName,
                    diamondCount,
                    repeatCount,
                    totalDiamonds,
                    tier,
                    sender: tiktokUsername,
                    timestamp: Date.now(),
                    action: "queued"
                });
            }

            console.log(
                `[Gift] @${tiktokUsername} sent ${giftName} `
                    + `x${repeatCount} (${totalDiamonds} 💎) -> `
                    + `@${robloxUsername} = ${tier}`
            );

        }
    );

    // ========================================================
    // CONNECT
    // ========================================================

    try {

        const state =
            await tiktokConnection.connect();

        console.log(
            `[TikTok] Successfully connected to @${TIKTOK_USERNAME}`
        );

        console.log(
            `[TikTok] Room ID: ${state?.roomId ?? "unknown"}`
        );

    } catch (error) {

        console.error(
            "[TikTok] Could not connect:"
        );

        console.error(error);

        console.log(
            `[TikTok] Make sure @${TIKTOK_USERNAME} is LIVE.`
        );
    }

}

// ============================================================
// TEST PAGE
// ============================================================
app.get("/health", (req, res) => {
    res.json({
        service: "avatar-rating-bridge",
        status: "ok"
    });
});
app.get(
    "/",
    (req, res) => {

        res.json({

            success: true,

            message:
                "TikTok Roblox Bridge is running!",

            tiktok:
                TIKTOK_USERNAME,

            queueSize:
                contestantQueue.length,

            queue:
                contestantQueue,
            admin:
                "/admin/",
            contest:
                contestState
        });
    }
);

// ============================================================
// MANUAL ADD
// ============================================================
app.post(
    "/admin/bridge/start",
    requireAdmin,
    (req, res) => {

        const result =
            startCloudflareBridge();

        res.json({
            ...result,
            bridge: bridgeState
        });
    }
);

app.post(
    "/admin/bridge/stop",
    requireAdmin,
    (req, res) => {

        const result =
            stopCloudflareBridge();

        res.json({
            ...result,
            bridge: bridgeState
        });
    }
);



app.get(
    "/admin/bridge/status",
    requireAdmin,
    (req, res) => {
        res.json({
            success: true,
            bridge: bridgeState
        });
    }
);

app.post(
    "/add-contestant",
    (req, res) => {

        const username =
            req.body?.username;

        if (!username) {

            return res.status(400).json({

                success: false,

                error:
                    "Missing username"

            });
        }

        const cleanedUsername =
            String(username)
                .trim()
                .replace(/^@+/g, "");

        const added =
            addContestant(
                cleanedUsername
            );

        res.json({

            success:
                added,

            username:
                cleanedUsername

        });
    }
);

// ============================================================
// ROBLOX GETS NEXT CONTESTANT
// ============================================================

app.get(
    "/next-contestant",
    (req, res) => {

        if (
            contestantQueue.length === 0
        ) {

            return res.json({
                success: true,
                username: null,
                boost: null
            });
        }

        // Lease the first item. Keep it in the Node queue until Roblox
        // confirms that QueueManager accepted it via /ack-contestant.
        // Repeated polls therefore cannot silently remove a contestant.
        const username = contestantQueue[0];

        const record = ensureRecord(username);
        if (record) {
            record.status = "node_queue";
            record.lastAction = "awaiting Roblox acknowledgement";
        }

        res.json({
            success: true,
            username,
            boost: null
        });
    }
);

// ============================================================
// ROBLOX ACKNOWLEDGES A CONTESTANT
// ============================================================

app.post("/ack-contestant", (req, res) => {
    const username = String(req.body?.username || "").trim().replace(/^@+/, "");
    const key = normalizeUsername(username);

    if (!key) {
        return res.status(400).json({ success: false, error: "Missing username" });
    }

    const index = contestantQueue.findIndex(item => normalizeUsername(item) === key);
    if (index < 0) {
        return res.json({ success: true, acknowledged: false, alreadyRemoved: true });
    }

    contestantQueue.splice(index, 1);
    const record = ensureRecord(username);
    if (record) {
        record.status = "roblox_queue";
        record.lastAction = "acknowledged by Roblox";
    }
    logEvent("CONTESTANT_ACK", `Roblox accepted @${username}`, { username });
    return res.json({ success: true, acknowledged: true });
});

// ============================================================
// ROBLOX GETS NEXT BOOST
// ============================================================

app.get(
    "/next-boost",
    (req, res) => {

        if (pendingBoosts.length === 0) {
            return res.json({
                success: true,
                boost: null
            });
        }

        // Do not consume a boost until Roblox can actually find
        // the target. This is the key reliability fix.
        let selectedIndex = -1;
        let selectedRank = -1;

        for (let i = 0; i < pendingBoosts.length; i++) {
            const boost = pendingBoosts[i];

            if (
                isInRobloxQueue(boost.username) ||
                isActiveInRoblox(boost.username)
            ) {
                const rank = boostRank(boost.tier);

                if (rank > selectedRank) {
                    selectedRank = rank;
                    selectedIndex = i;
                }
            }
        }

        if (selectedIndex === -1) {
            return res.json({
                success: true,
                boost: null
            });
        }

        const boost = pendingBoosts[selectedIndex];

        console.log(
            `[Bridge] Leasing boost to Roblox: ${boost.tier} -> @${boost.username}`
        );

        res.json({
            success: true,
            boost
        });
    }
);

// ============================================================
// ROBLOX ACKNOWLEDGES A GIFT EFFECT
// ============================================================

app.post("/ack-boost", (req, res) => {
    const id = String(req.body?.id || "");
    if (!id) return res.status(400).json({ success: false, error: "Missing boost id" });

    const index = pendingBoosts.findIndex(boost => boost.id === id);
    if (index < 0) {
        return res.json({ success: true, acknowledged: false, alreadyRemoved: true });
    }

    const [boost] = pendingBoosts.splice(index, 1);
    const record = ensureRecord(boost.username);
    if (record) {
        const effect = [...record.effects].reverse().find(item =>
            item.tier === boost.tier && !item.applied
        );
        if (effect) {
            effect.applied = true;
            effect.confirmedAt = Date.now();
            effect.confirmation = `${boost.tier} acknowledged by Roblox`;
        }
        record.lastAction = `${boost.tier} acknowledged by Roblox`;
    }
    logEvent("BOOST_ACK", `Roblox acknowledged ${boost.tier} for @${boost.username}`, {
        username: boost.username, tier: boost.tier, source: boost.source
    });
    res.json({ success: true, acknowledged: true });
});

// ============================================================
// QUEUE STATUS
// ============================================================

app.get(
    "/queue",
    (req, res) => {

        res.json({

            success: true,

            count:
                contestantQueue.length,

            contestants:
                contestantQueue

        });
    }
);

// ============================================================
// RESET CONTEST
// ============================================================

app.post(
    "/reset-contest",
    (req, res) => {

        resetContestSubmissions();

        console.log(
            "[Contest] Ready for next contest."
        );

        res.json({
            success: true,
            message: "Contest reset.",
            contest: contestState
        });
    }
);

app.get("/test-rose", (req, res) => {

    if (!TEST_MODE) {
        return res.status(404).json({
            success: false,
            message: "Test endpoint disabled."
        });
    }

    // Pass ?username=SomeName to test the skip-to-front

});

// ============================================================
// CLEAR QUEUE
// ============================================================

app.post(
    "/clear-queue",
    (req, res) => {

        const cleared =
            clearNodeQueue(
                "manual"
            );

        res.json({
            success: true,
            message: "Queue cleared.",
            cleared
        });
    }
);


// ============================================================
// ROBLOX STATE HEARTBEAT
// ============================================================

app.post(
    "/roblox-state",
    (req, res) => {

        const body = req.body || {};

        robloxState.queue =
            Array.isArray(body.queue)
                ? body.queue
                : [];

        robloxState.active =
            Array.isArray(body.active)
                ? body.active
                : [];

        robloxState.contestRunning =
            !!body.contestRunning;

        robloxState.phase =
            String(
                body.phase || "WAITING"
            );

        robloxState.timeRemaining =
            Number(
                body.timeRemaining || 0
            );

        robloxState.lastHeartbeat =
            Date.now();

        contestState.running =
            robloxState.contestRunning;

        contestState.phase =
            robloxState.phase;

        contestState.timeRemaining =
            robloxState.timeRemaining;

        updateRecordStatuses();

        // Confirm effects from the actual Roblox model. GIANT is
        // considered confirmed only when Roblox reports GiftEffect=GIANT
        // and an approximately 10x model scale.
        for (const active of robloxState.active) {

            const record =
                recordFor(active?.username);

            if (!record) {
                continue;
            }

            const effect =
                String(
                    active?.giftEffect || ""
                ).toUpperCase();

            const scale =
                Number(active?.scale || 1);

            if (!effect) {
                continue;
            }

            for (const entry of record.effects) {
                if (
                    String(entry.tier).toUpperCase() === effect
                ) {
                    entry.applied = true;
                    entry.confirmedAt = Date.now();
                    entry.confirmation =
                        effect === "GIANT"
                            ? scale >= 9.9
                                ? "GIANT confirmed at 10x scale"
                                : `GIANT effect reported but scale=${scale}`
                            : `${effect} confirmed by Roblox`;
                }
            }

            record.lastAction =
                effect === "GIANT" && scale >= 9.9
                    ? "GIANT confirmed (10x)"
                    : `${effect} confirmed`;
        }

        res.json({
            success: true
        });
    }
);

// ============================================================
// CONTEST END NOTIFICATION
// ============================================================

app.post(
    "/contest-ended",
    (req, res) => {

        const clearedQueue =
            Array.isArray(req.body?.clearedQueue)
                ? req.body.clearedQueue
                : [];

        endContest(clearedQueue);

        res.json({
            success: true,
            clearedCount:
                contestState.clearedQueue.length
        });
    }
);

// ============================================================
// ADMIN STATE
// ============================================================

app.get(
    "/admin/state",
    requireAdmin,
    (req, res) => {

        updateRecordStatuses();

        const nodeQueue =
            contestantQueue.map(
                (username, index) => ({
                    username,
                    source: "node",
                    position: index + 1
                })
            );

        const robloxQueue =
            robloxState.queue.map(
                (item, index) => ({
                    ...item,
                    source: "roblox",
                    position: index + 1
                })
            );

        res.json({
            success: true,
            contest: contestState,
            roblox: {
                ...robloxState,
                heartbeatAgeMs:
                    Date.now() -
                    robloxState.lastHeartbeat
            },
            queue: {
                roblox: robloxQueue,
                node: nodeQueue,
                combined: [
                    ...robloxQueue,
                    ...nodeQueue.map(item => ({
                        ...item,
                        position:
                            robloxQueue.length +
                            item.position
                    }))
                ]
            },
            contestants:
                [...contestantRecords.values()],
            events:
                eventLog,
            pendingBoosts:
                pendingBoosts.map(boost => ({
                    ...boost
                })),
            lastContest:
                lastContestSummary
        });
    }
);

// ============================================================
// ADMIN ACTIONS
// ============================================================

app.post(
    "/admin/action",
    requireAdmin,
    (req, res) => {

        const username =
            String(
                req.body?.username || ""
            )
                .trim()
                .replace(/^@+/, "");

        const action =
            String(
                req.body?.action || ""
            )
                .trim()
                .toUpperCase();

        if (
            !username ||
            !["SKIP", "GLOW", "GIANT"].includes(action)
        ) {
            return res.status(400).json({
                success: false,
                error:
                    "username and action (SKIP, GLOW or GIANT) are required"
            });
        }

        const record =
            recordFor(username);

        if (!record) {
            return res.status(404).json({
                success: false,
                error:
                    `@${username} is not in the current contest`
            });
        }

        let result;

        if (action === "SKIP") {
            result =
                applySkip(
                    username,
                    "ADMIN",
                    "admin"
                );
        } else {
            queueBoost(
                username,
                action,
                "ADMIN",
                "admin"
            );

            result =
                isActiveInRoblox(username)
                    ? "active"
                    : isInRobloxQueue(username)
                        ? "roblox_queue"
                        : "pending";
        }

        res.json({
            success: true,
            username,
            action,
            result
        });
    }
);

// ============================================================
// DASHBOARD TEST PLAYERS
// ============================================================
// Adds a controlled mix of known real Roblox accounts and deliberately
// fake usernames so the queue can be tested against avatar lookup failures.
// The Roblox queue processor should skip username_not_found and continue.
app.post("/admin/test-players", requireAdmin, async (req, res) => {
    const count = Number(req.body?.count);
    if (![5, 10].includes(count)) {
        return res.status(400).json({
            success: false,
            error: "count must be 5 or 10"
        });
    }

    const realUsernames = [
        "Roblox",
        "Builderman",
        "Stickmasterluke",
        "Shedletsky",
        "clockwork"
    ];

    const realCount = count === 5 ? 3 : 5;
    const fakeCount = count - realCount;

    // Generate Roblox-format usernames and verify they do not exist before
    // adding them. This ensures the "fake" test entries really exercise the
    // username_not_found path instead of accidentally using a real account.
    const fakeUsernames = [];
    try {
        for (let attempt = 0; fakeUsernames.length < fakeCount && attempt < 5; attempt++) {
            const remaining = fakeCount - fakeUsernames.length;
            const proposals = Array.from({ length: remaining }, () =>
                "NoUser" + crypto.randomBytes(6).toString("hex").slice(0, 12)
            );
            const check = await fetch("https://users.roblox.com/v1/usernames/users", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    usernames: proposals,
                    excludeBannedUsers: false
                }),
                signal: AbortSignal.timeout(5000)
            });
            if (!check.ok) throw new Error("Roblox username validation HTTP " + check.status);
            const data = await check.json();
            const existing = new Set((data.data || []).map(user =>
                String(user.requestedUsername || user.name || "").toLowerCase()
            ));
            for (const username of proposals) {
                if (!existing.has(username.toLowerCase())) fakeUsernames.push(username);
            }
        }
    } catch (error) {
        return res.status(502).json({
            success: false,
            error: "Could not verify fake test usernames with Roblox. Try again: " + error.message
        });
    }

    if (fakeUsernames.length < fakeCount) {
        return res.status(502).json({
            success: false,
            error: "Could not generate enough verified nonexistent Roblox usernames. Try again."
        });
    }

    const candidates = [];

    for (let i = 0; i < realCount; i++) {
        candidates.push({
            username: realUsernames[i],
            kind: "real"
        });
    }
    for (let i = 0; i < fakeCount; i++) {
        candidates.push({
            username: fakeUsernames[i],
            kind: "fake"
        });
    }

    // Interleave the fake names between real accounts so the operator can
    // confirm a failed avatar lookup doesn't block later valid contestants.
    const ordered = [];
    for (let i = 0; i < Math.max(realCount, fakeCount); i++) {
        if (i < realCount) ordered.push(candidates[i]);
        if (i < fakeCount) ordered.push(candidates[realCount + i]);
    }

    const added = [];
    for (const item of ordered) {
        const ok = addContestant(item.username, {
            tiktokUser: item.kind === "real"
                ? "DASHBOARD TEST · REAL"
                : "DASHBOARD TEST · FAKE",
            testPlayer: true,
            testKind: item.kind,
            submittedAt: Date.now(),
            status: "node_queue"
        });
        if (ok) added.push(item);
    }

    logEvent(
        "TEST_BATCH",
        `Dashboard added ${added.length} test players (${realCount} real, ${fakeCount} fake)`,
        { added, requestedCount: count }
    );

    return res.json({
        success: true,
        requestedCount: count,
        added,
        realCount: added.filter(x => x.kind === "real").length,
        fakeCount: added.filter(x => x.kind === "fake").length
    });
});

app.post(
    "/admin/add",
    requireAdmin,
    (req, res) => {

        const username =
            String(
                req.body?.username || ""
            )
                .trim()
                .replace(/^@+/, "");

        if (!username) {
            return res.status(400).json({
                success: false,
                error: "Missing username"
            });
        }

        const added =
            addContestant(
                username,
                {
                    tiktokUser: "ADMIN"
                }
            );

        res.json({
            success: added,
            username
        });
    }
);

app.post(
    "/admin/clear-node-queue",
    requireAdmin,
    (req, res) => {

        const cleared =
            clearNodeQueue(
                "admin"
            );

        logEvent(
            "ADMIN_CLEAR",
            `Admin cleared ${cleared.length} incoming contestants`,
            {
                clearedQueue: cleared
            }
        );

        res.json({
            success: true,
            cleared
        });
    }
);



// ============================================================
// ADMIN DASHBOARD
// ============================================================

app.use(
    "/admin",
    express.static(
        path.join(
            __dirname,
            "admin"
        )
    )
);

// ADD THIS ROUTE
app.get("/admin/help", (req, res) => {
    res.sendFile(
        path.join(
            __dirname,
            "admin",
            "help.html"
        )
    );
});

app.get(
    "/admin",
    (req, res) => {
        res.sendFile(
            path.join(
                __dirname,
                "admin",
                "index.html"
            )
        );
    }
);

// ============================================================
// START SERVER
// ============================================================

app.listen(
    PORT,
    "127.0.0.1",
    () => {

        console.log(
            "================================================"
        );

        console.log(
            `Bridge running on http://localhost:${PORT}`
        );

        console.log(
            `[TikTok] Account: @${TIKTOK_USERNAME}`
        );

        console.log(
            "Anti-spam: ENABLED"
        );

        console.log(
            `Rate cooldown: ${RATE_COOLDOWN}ms`
        );

        console.log(
            "Plain username mode: ENABLED"
        );

        console.log(
            `[Admin] Dashboard: http://localhost:${PORT}/admin/`
        );

        console.log(
            "================================================"
        );

        console.log(
            "[Contest] Waiting for Roblox to start/reset the contest."
        );

        startTikTok();
    }


);
