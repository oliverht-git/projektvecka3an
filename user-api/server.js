const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const USER_FILE = process.env.USER_FILE || path.join(ROOT, "user.json");
const PORT = Number(process.env.PORT || 3006);
const MAX_BODY_SIZE = 256 * 1024;
const MAX_PROFILE_PICTURE_LENGTH = 200 * 1024;
let updateQueue = Promise.resolve();

function sendJson(response, statusCode, data) {
    response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(data));
}

function authorizeAdmin(request, response, adminToken) {
    const authorization = request.headers.authorization || "";
    const suppliedToken = authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : "";
    const expectedHash = createHash("sha256").update(adminToken.trim()).digest();
    const suppliedHash = createHash("sha256").update(suppliedToken).digest();
    if (!timingSafeEqual(expectedHash, suppliedHash)) {
        sendJson(response, 401, { error: "Admin authorization is required." });
        return false;
    }
    return true;
}

async function readUsers() {
    let data;
    try {
        data = await fs.readFile(USER_FILE, "utf8");
    } catch (error) {
        if (error.code === "ENOENT") {
            return { users: [] };
        }
        throw error;
    }

    const userData = JSON.parse(data);
    if (!userData || !Array.isArray(userData.users)) {
        throw new Error("user.json must contain a users array.");
    }
    return userData;
}

function updateUsers(update) {
    const operation = updateQueue.then(async () => {
        const userData = await readUsers();
        const result = update(userData.users, userData);
        const temporaryFile = `${USER_FILE}.${process.pid}.tmp`;
        await fs.writeFile(temporaryFile, `${JSON.stringify(userData, null, 2)}\n`, "utf8");
        await fs.rename(temporaryFile, USER_FILE);
        return result;
    });
    updateQueue = operation.catch(() => {});
    return operation;
}

async function ensureUserIds() {
    let userData = await readUsers();
    if (userData.users.some(user => !user.id)) {
        await updateUsers(users => {
            users.forEach(user => {
                user.id = user.id || randomUUID();
            });
        });
        userData = await readUsers();
    }
    return userData;
}

function addAcceptedChats(users, userData) {
    userData.chats = Array.isArray(userData.chats) ? userData.chats : [];
    const usersById = new Map(users.map(user => [user.id, user]));

    (Array.isArray(userData.requests) ? userData.requests : [])
        .filter(request => request.status === "accepted")
        .forEach(request => {
            if (!usersById.has(request.fromId) || !usersById.has(request.toId)) {
                return;
            }

            const participantIds = [request.fromId, request.toId].sort();
            const existingChat = userData.chats.some(chat =>
                Array.isArray(chat.participantIds)
                && chat.participantIds.length === participantIds.length
                && chat.participantIds.every((id, index) => id === participantIds[index])
            );
            if (!existingChat) {
                userData.chats.push({
                    id: randomUUID(),
                    participantIds,
                    createdAt: request.acceptedAt || request.createdAt || new Date().toISOString(),
                    messages: []
                });
            }
        });
}

async function ensureAcceptedChats() {
    const userData = await ensureUserIds();
    const acceptedRequests = (Array.isArray(userData.requests) ? userData.requests : [])
        .filter(request => request.status === "accepted");
    const hasMissingChats = acceptedRequests.some(request => {
        const participantIds = [request.fromId, request.toId].sort();
        return !userData.chats?.some(chat =>
            Array.isArray(chat.participantIds)
            && chat.participantIds.length === participantIds.length
            && chat.participantIds.every((id, index) => id === participantIds[index])
        );
    });

    if (hasMissingChats) {
        await updateUsers(addAcceptedChats);
        return readUsers();
    }

    return userData;
}

function readRequestBody(request) {
    return new Promise((resolve, reject) => {
        let body = "";
        let settled = false;
        request.on("data", chunk => {
            if (settled) {
                return;
            }
            body += chunk;
            if (Buffer.byteLength(body) > MAX_BODY_SIZE) {
                settled = true;
                const error = new Error("Request body is too large.");
                error.statusCode = 413;
                reject(error);
            }
        });
        request.on("end", () => {
            if (settled) {
                return;
            }
            try {
                resolve(JSON.parse(body));
            } catch {
                const error = new Error("Request body must be valid JSON.");
                error.statusCode = 400;
                reject(error);
            }
        });
        request.on("error", error => {
            if (!settled) {
                reject(error);
            }
        });
    });
}

function serveStaticFile(request, response, pathname) {
    let decodedPath;
    try {
        decodedPath = decodeURIComponent(pathname);
    } catch {
        sendJson(response, 400, { error: "Invalid URL path." });
        return;
    }

    const relativePath = decodedPath === "/" ? "index.html" : decodedPath.slice(1);
    const filePath = path.resolve(ROOT, relativePath);
    const rootRelativePath = path.relative(ROOT, filePath);
    if (
        !rootRelativePath
        || rootRelativePath.startsWith("..")
        || path.isAbsolute(rootRelativePath)
        || rootRelativePath.toLowerCase() === "user.json"
        || rootRelativePath.split(path.sep)[0].toLowerCase() === "user-api"
    ) {
        sendJson(response, 404, { error: "Not found." });
        return;
    }

    const contentTypes = {
        ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml"
    };

    fs.readFile(filePath).then(contents => {
        response.writeHead(200, {
            "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream"
        });
        response.end(request.method === "HEAD" ? undefined : contents);
    }).catch(error => {
        if (error.code === "ENOENT" || error.code === "EISDIR") {
            sendJson(response, 404, { error: "Not found." });
            return;
        }
        console.error("Could not serve static file:", error);
        sendJson(response, 500, { error: "Could not serve file." });
    });
}

function createServer() {
    const configuredToken = typeof process.env.ADMIN_TOKEN === "string"
        ? process.env.ADMIN_TOKEN.trim()
        : "";
    const adminToken = configuredToken || randomBytes(32).toString("hex");
    if (!configuredToken) {
        console.log(`Adminnyckel (kopiera denna): ${adminToken}`);
    }

    return http.createServer(async (request, response) => {
        const url = new URL(request.url, "http://localhost");
        try {
            if (url.pathname.startsWith("/api/admin/")) {
                if (!authorizeAdmin(request, response, adminToken)) {
                    return;
                }
                response.setHeader("Cache-Control", "no-store");

                if (request.method === "GET" && url.pathname === "/api/admin/users") {
                    const userData = await ensureUserIds();
                    const reports = Array.isArray(userData.reports) ? userData.reports : [];
                    const users = userData.users.map(user => ({
                        id: user.id,
                        email: user.email,
                        username: typeof user.username === "string" && user.username.trim()
                            ? user.username.trim()
                            : "Användare",
                        active: user.active === true,
                        reportCount: reports.filter(report => report.reportedUserId === user.id).length,
                        profilePicture: typeof user.profilePicture === "string"
                            ? user.profilePicture
                            : null
                    }));
                    sendJson(response, 200, { users });
                    return;
                }

                const adminUserMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
                if (request.method === "DELETE" && adminUserMatch) {
                    const deleted = await updateUsers((users, userData) => {
                        const userId = decodeURIComponent(adminUserMatch[1]);
                        const index = users.findIndex(user => user.id === userId);
                        if (index === -1) {
                            return false;
                        }

                        users.splice(index, 1);
                        if (Array.isArray(userData.requests)) {
                            userData.requests = userData.requests.filter(entry =>
                                entry.fromId !== userId && entry.toId !== userId);
                        }
                        if (Array.isArray(userData.chats)) {
                            userData.chats = userData.chats.filter(chat =>
                                !chat.participantIds.includes(userId));
                        }
                        for (const key of ["skips", "userBlocks"]) {
                            if (Array.isArray(userData[key])) {
                                userData[key] = userData[key].filter(entry =>
                                    entry.viewerId !== userId
                                    && entry.targetId !== userId
                                    && entry.reporterId !== userId
                                    && entry.blockedUserId !== userId);
                            }
                        }
                        return true;
                    });
                    if (!deleted) {
                        sendJson(response, 404, { error: "User not found." });
                        return;
                    }
                    sendJson(response, 200, { ok: true });
                    return;
                }

                if (request.method === "GET" && url.pathname === "/api/admin/reports") {
                    const userData = await readUsers();
                    const reports = (Array.isArray(userData.reports) ? userData.reports : [])
                        .map(report => ({
                            ...report,
                            chatLog: report.chatId
                                ? (Array.isArray(userData.chatLogs) ? userData.chatLogs : [])
                                    .filter(message => message.chatId === report.chatId)
                                    .sort((left, right) =>
                                        Date.parse(left.createdAt) - Date.parse(right.createdAt))
                                : []
                        }))
                        .sort((left, right) =>
                            Date.parse(right.createdAt) - Date.parse(left.createdAt));
                    sendJson(response, 200, { reports });
                    return;
                }

                const reportStatusMatch = url.pathname.match(/^\/api\/admin\/reports\/([^/]+)\/status$/);
                if (request.method === "POST" && reportStatusMatch) {
                    const body = await readRequestBody(request);
                    const status = body && typeof body.status === "string" ? body.status : "";
                    if (!["open", "reviewed", "dismissed"].includes(status)) {
                        sendJson(response, 400, { error: "Invalid report status." });
                        return;
                    }

                    const report = await updateUsers((users, userData) => {
                        const reports = Array.isArray(userData.reports) ? userData.reports : [];
                        const match = reports.find(entry => entry.id === reportStatusMatch[1]);
                        if (!match) {
                            return null;
                        }
                        match.status = status;
                        match.updatedAt = new Date().toISOString();
                        const pairHasActiveReport = reports.some(entry =>
                            entry.reporterId === match.reporterId
                            && entry.reportedUserId === match.reportedUserId
                            && entry.status !== "dismissed"
                        );
                        userData.userBlocks = Array.isArray(userData.userBlocks) ? userData.userBlocks : [];
                        userData.userBlocks = userData.userBlocks.filter(block =>
                            !(block.reporterId === match.reporterId
                                && block.blockedUserId === match.reportedUserId)
                        );
                        if (pairHasActiveReport) {
                            userData.userBlocks.push({
                                reporterId: match.reporterId,
                                blockedUserId: match.reportedUserId,
                                reportId: match.id,
                                createdAt: match.updatedAt
                            });
                        }
                        return match;
                    });
                    if (!report) {
                        sendJson(response, 404, { error: "Report not found." });
                        return;
                    }
                    sendJson(response, 200, { report });
                    return;
                }

                sendJson(response, 404, { error: "Admin endpoint not found." });
                return;
            }

            if (request.method === "POST" && url.pathname === "/api/reports") {
                const body = await readRequestBody(request);
                const reporterEmail = body && typeof body.reporterEmail === "string"
                    ? body.reporterEmail.trim().toLowerCase()
                    : "";
                const targetType = body && typeof body.targetType === "string" ? body.targetType : "";
                const targetId = body && typeof body.targetId === "string" ? body.targetId : "";
                const reason = body && typeof body.reason === "string" ? body.reason.trim() : "";
                const details = body && typeof body.details === "string" ? body.details.trim() : "";
                const allowedReasons = ["olämplig profilbild", "trakasserier", "hot", "spam", "annat"];
                if (
                    !reporterEmail
                    || !["profile", "message"].includes(targetType)
                    || !targetId
                    || !allowedReasons.includes(reason)
                    || details.length > 500
                ) {
                    sendJson(response, 400, { error: "Invalid report details." });
                    return;
                }

                const result = await updateUsers((users, userData) => {
                    const reporter = users.find(user => user.email === reporterEmail);
                    if (!reporter) {
                        return { error: "Reporter not found.", statusCode: 404 };
                    }

                    let target;
                    let profilePicture = null;
                    let chatId = null;
                    let messageId = null;
                    let messageText = null;
                    let participants = [];
                    if (targetType === "profile") {
                        target = users.find(user => user.id === targetId);
                        if (!target || target.id === reporter.id) {
                            return { error: "Profile not found.", statusCode: 404 };
                        }
                        profilePicture = typeof target.profilePicture === "string"
                            ? target.profilePicture
                            : null;
                    } else {
                        const chats = Array.isArray(userData.chats) ? userData.chats : [];
                        const chat = chats.find(entry =>
                            Array.isArray(entry.participantIds) && entry.participantIds.includes(reporter.id)
                            && (Array.isArray(entry.messages)
                                ? entry.messages.some(message => message.id === targetId)
                                : false)
                        );
                        const message = chat && chat.messages.find(entry => entry.id === targetId);
                        if (!chat || !message || message.senderId === reporter.id) {
                            return { error: "Message not found.", statusCode: 404 };
                        }

                        target = users.find(user => user.id === message.senderId);
                        if (!target) {
                            return { error: "Message sender not found.", statusCode: 404 };
                        }
                        chatId = chat.id;
                        messageId = message.id;
                        messageText = message.text;
                        participants = chat.participantIds.map(id => {
                            const participant = users.find(user => user.id === id);
                            return {
                                id,
                                username: participant && typeof participant.username === "string"
                                    ? participant.username.trim()
                                    : "Användare"
                            };
                        });

                        userData.chatLogs = Array.isArray(userData.chatLogs) ? userData.chatLogs : [];
                        const loggedMessageIds = new Set(
                            userData.chatLogs.filter(entry => entry.chatId === chat.id)
                                .map(entry => entry.id)
                        );
                        chat.messages.forEach(entry => {
                            if (!loggedMessageIds.has(entry.id)) {
                                const sender = users.find(user => user.id === entry.senderId);
                                userData.chatLogs.push({
                                    id: entry.id,
                                    chatId: chat.id,
                                    senderId: entry.senderId,
                                    senderName: sender && typeof sender.username === "string"
                                        ? sender.username.trim()
                                        : "Användare",
                                    text: entry.text,
                                    createdAt: entry.createdAt
                                });
                            }
                        });
                    }

                    userData.reports = Array.isArray(userData.reports) ? userData.reports : [];
                    const duplicate = userData.reports.some(report =>
                        report.reporterId === reporter.id
                        && report.targetType === targetType
                        && report.targetId === targetId
                    );
                    if (duplicate) {
                        return { error: "This item has already been reported.", statusCode: 409 };
                    }

                    const report = {
                        id: randomUUID(),
                        targetType,
                        targetId,
                        reporterId: reporter.id,
                        reporterName: typeof reporter.username === "string"
                            ? reporter.username.trim()
                            : "Användare",
                        reportedUserId: target.id,
                        reportedUsername: typeof target.username === "string"
                            ? target.username.trim()
                            : "Användare",
                        reason,
                        details,
                        status: "open",
                        createdAt: new Date().toISOString(),
                        profilePicture,
                        chatId,
                        messageId,
                        messageText,
                        participants
                    };
                    userData.reports.push(report);
                    userData.userBlocks = Array.isArray(userData.userBlocks) ? userData.userBlocks : [];
                    if (!userData.userBlocks.some(block =>
                        block.reporterId === reporter.id && block.blockedUserId === target.id
                    )) {
                        userData.userBlocks.push({
                            reporterId: reporter.id,
                            blockedUserId: target.id,
                            reportId: report.id,
                            createdAt: report.createdAt
                        });
                    }
                    return { report };
                });
                if (result.error) {
                    sendJson(response, result.statusCode, { error: result.error });
                    return;
                }
                sendJson(response, 201, { ok: true, reportId: result.report.id });
                return;
            }

            if (request.method === "POST" && url.pathname === "/api/users/login") {
                const body = await readRequestBody(request);
                const email = body && typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
                const username = body && typeof body.username === "string"
                    ? body.username.trim() || email
                    : email;
                if (!email) {
                    sendJson(response, 400, { error: "Email is required." });
                    return;
                }

                const lastLogin = new Date().toISOString();
                await updateUsers(users => {
                    const existingUser = users.find(user => user.email === email);
                    if (existingUser) {
                        existingUser.id = existingUser.id || randomUUID();
                        existingUser.username = username;
                        existingUser.active = true;
                        existingUser.lastLogin = lastLogin;
                    } else {
                        users.push({ id: randomUUID(), email, username, active: true, lastLogin });
                    }
                });
                sendJson(response, 200, { ok: true });
                return;
            }

            if (request.method === "GET" && url.pathname === "/api/users/profiles") {
                const excludedEmail = (url.searchParams.get("exclude") || "").trim().toLowerCase();
                const userData = await ensureUserIds();
                const viewer = userData.users.find(user => user.email === excludedEmail);
                const hiddenEmails = new Set([excludedEmail]);
                if (viewer) {
                    const usersById = new Map(userData.users.map(user => [user.id, user]));
                    (Array.isArray(userData.requests) ? userData.requests : [])
                        .filter(request =>
                            (request.fromId === viewer.id || request.toId === viewer.id)
                            && (request.status === "accepted" || request.status === "pending")
                        )
                        .forEach(request => {
                            const otherUser = usersById.get(
                                request.fromId === viewer.id ? request.toId : request.fromId
                            );
                            if (otherUser && typeof otherUser.email === "string") {
                                hiddenEmails.add(otherUser.email.trim().toLowerCase());
                            }
                        });
                }

                const skipCounts = new Map();
                (Array.isArray(userData.skips) ? userData.skips : [])
                    .filter(skip => viewer && skip.viewerId === viewer.id)
                    .forEach(skip => {
                        skipCounts.set(skip.targetId, (skipCounts.get(skip.targetId) || 0) + skip.count);
                    });
                const seenEmails = new Set();
                const seenIds = new Set();
                const profiles = userData.users
                    .filter(user => {
                        const email = typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
                        if (
                            !email
                            || hiddenEmails.has(email)
                            || seenEmails.has(email)
                            || seenIds.has(user.id)
                            || (viewer && (skipCounts.get(user.id) || 0) >= 4)
                        ) {
                            return false;
                        }
                        seenEmails.add(email);
                        seenIds.add(user.id);
                        return true;
                    })
                    .map(user => {
                        const username = typeof user.username === "string" ? user.username.trim() : "";
                        return {
                            id: user.id,
                            username: username && username.toLowerCase() !== user.email.toLowerCase()
                                ? username
                                : "Användare",
                            profilePicture: typeof user.profilePicture === "string"
                                ? user.profilePicture
                                : null
                        };
                    });
                sendJson(response, 200, { profiles });
                return;
            }

            if (request.method === "POST" && url.pathname === "/api/users/skip") {
                const body = await readRequestBody(request);
                const email = body && typeof body.email === "string"
                    ? body.email.trim().toLowerCase()
                    : "";
                const targetId = body && typeof body.targetId === "string" ? body.targetId : "";
                if (!email || !targetId) {
                    sendJson(response, 400, { error: "Email and profile ID are required." });
                    return;
                }

                const result = await updateUsers((users, userData) => {
                    const viewer = users.find(user => user.email === email);
                    const target = users.find(user => user.id === targetId);
                    if (!viewer || !target || viewer.id === target.id) {
                        return { error: "Profile not found." };
                    }

                    const hasRelationship = (Array.isArray(userData.requests) ? userData.requests : [])
                        .some(profileRequest =>
                            (profileRequest.fromId === viewer.id && profileRequest.toId === target.id)
                            || (profileRequest.fromId === target.id && profileRequest.toId === viewer.id)
                        );
                    if (hasRelationship) {
                        return { error: "This profile is already connected or has a pending request." };
                    }

                    userData.skips = Array.isArray(userData.skips) ? userData.skips : [];
                    let skip = userData.skips.find(entry =>
                        entry.viewerId === viewer.id && entry.targetId === target.id
                    );
                    if (!skip) {
                        skip = { viewerId: viewer.id, targetId: target.id, count: 0 };
                        userData.skips.push(skip);
                    }
                    skip.count = Math.min(4, Number.isInteger(skip.count) ? skip.count + 1 : 1);
                    return { remainingShows: Math.max(0, 4 - skip.count) };
                });
                if (result.error) {
                    sendJson(response, 404, { error: result.error });
                    return;
                }
                sendJson(response, 200, { ok: true, remainingShows: result.remainingShows });
                return;
            }

            if (request.method === "GET" && url.pathname === "/api/users/friends") {
                const email = (url.searchParams.get("email") || "").trim().toLowerCase();
                if (!email) {
                    sendJson(response, 400, { error: "Email is required." });
                    return;
                }

                const userData = await ensureUserIds();
                const user = userData.users.find(entry => entry.email === email);
                if (!user) {
                    sendJson(response, 404, { error: "User not found." });
                    return;
                }

                const usersById = new Map(userData.users.map(entry => [entry.id, entry]));
                const friendIds = new Set();
                (Array.isArray(userData.requests) ? userData.requests : [])
                    .filter(request => request.status === "accepted")
                    .forEach(request => {
                        if (request.fromId === user.id) {
                            friendIds.add(request.toId);
                        } else if (request.toId === user.id) {
                            friendIds.add(request.fromId);
                        }
                    });

                const friends = Array.from(friendIds)
                    .map(id => usersById.get(id))
                    .filter(Boolean)
                    .map(friend => {
                        const username = typeof friend.username === "string" ? friend.username.trim() : "";
                        return {
                            id: friend.id,
                            username: username && username.toLowerCase() !== friend.email.toLowerCase()
                                ? username
                                : "Användare",
                            profilePicture: typeof friend.profilePicture === "string"
                                ? friend.profilePicture
                                : null
                        };
                    });
                sendJson(response, 200, { friends });
                return;
            }

            if (request.method === "POST" && url.pathname === "/api/users/friends/remove") {
                const body = await readRequestBody(request);
                const email = body && typeof body.email === "string"
                    ? body.email.trim().toLowerCase()
                    : "";
                const friendId = body && typeof body.friendId === "string" ? body.friendId : "";
                if (!email || !friendId) {
                    sendJson(response, 400, { error: "Email and friend ID are required." });
                    return;
                }

                const removed = await updateUsers((users, userData) => {
                    const user = users.find(entry => entry.email === email);
                    const friend = users.find(entry => entry.id === friendId);
                    if (!user || !friend) {
                        return false;
                    }

                    const requests = Array.isArray(userData.requests) ? userData.requests : [];
                    const friendshipExists = requests.some(request =>
                        request.status === "accepted"
                        && (
                            (request.fromId === user.id && request.toId === friend.id)
                            || (request.fromId === friend.id && request.toId === user.id)
                        )
                    );
                    if (!friendshipExists) {
                        return false;
                    }

                    userData.requests = requests.filter(request => !(
                        (request.fromId === user.id && request.toId === friend.id)
                        || (request.fromId === friend.id && request.toId === user.id)
                    ));
                    if (Array.isArray(userData.chats)) {
                        userData.chats = userData.chats.filter(chat => !(
                            Array.isArray(chat.participantIds)
                            && chat.participantIds.includes(user.id)
                            && chat.participantIds.includes(friend.id)
                        ));
                    }
                    return true;
                });
                if (!removed) {
                    sendJson(response, 404, { error: "Friend not found." });
                    return;
                }

                sendJson(response, 200, { ok: true });
                return;
            }

            if (request.method === "POST" && url.pathname === "/api/users/requests") {
                const body = await readRequestBody(request);
                const fromEmail = body && typeof body.fromEmail === "string"
                    ? body.fromEmail.trim().toLowerCase()
                    : "";
                const toId = body && typeof body.toId === "string" ? body.toId : "";
                if (!fromEmail || !toId) {
                    sendJson(response, 400, { error: "Sender email and recipient ID are required." });
                    return;
                }

                const result = await updateUsers((users, userData) => {
                    const sender = users.find(user => user.email === fromEmail);
                    const recipient = users.find(user => user.id === toId);
                    if (!sender || !recipient || sender.id === recipient.id) {
                        return { error: "User not found." };
                    }

                    userData.requests = Array.isArray(userData.requests) ? userData.requests : [];
                    const existing = userData.requests.find(request =>
                        request.fromId === sender.id && request.toId === recipient.id
                    );
                    if (existing) {
                        return { status: existing.status };
                    }

                    userData.requests.push({
                        id: randomUUID(),
                        fromId: sender.id,
                        toId: recipient.id,
                        status: "pending",
                        createdAt: new Date().toISOString()
                    });
                    return { status: "pending" };
                });
                if (result.error) {
                    sendJson(response, 404, { error: result.error });
                    return;
                }

                sendJson(response, 200, { ok: true, status: result.status });
                return;
            }

            if (request.method === "GET" && url.pathname === "/api/users/requests") {
                const recipientEmail = (url.searchParams.get("email") || "").trim().toLowerCase();
                if (!recipientEmail) {
                    sendJson(response, 400, { error: "Email is required." });
                    return;
                }

                const userData = await ensureUserIds();
                const recipient = userData.users.find(user => user.email === recipientEmail);
                if (!recipient) {
                    sendJson(response, 404, { error: "User not found." });
                    return;
                }

                const usersById = new Map(userData.users.map(user => [user.id, user]));
                const requests = (Array.isArray(userData.requests) ? userData.requests : [])
                    .filter(request => request.toId === recipient.id && request.status === "pending")
                    .map(request => {
                        const sender = usersById.get(request.fromId);
                        return sender ? {
                            id: request.id,
                            username: typeof sender.username === "string"
                                && sender.username.trim()
                                && sender.username.trim().toLowerCase() !== sender.email.toLowerCase()
                                ? sender.username.trim()
                                : "Användare",
                            profilePicture: typeof sender.profilePicture === "string"
                                ? sender.profilePicture
                                : null,
                            createdAt: request.createdAt
                        } : null;
                    })
                    .filter(Boolean);
                sendJson(response, 200, { requests });
                return;
            }

            if (request.method === "POST" && url.pathname === "/api/users/requests/accept") {
                const body = await readRequestBody(request);
                const recipientEmail = body && typeof body.email === "string"
                    ? body.email.trim().toLowerCase()
                    : "";
                const requestId = body && typeof body.requestId === "string" ? body.requestId : "";
                if (!recipientEmail || !requestId) {
                    sendJson(response, 400, { error: "Recipient email and request ID are required." });
                    return;
                }

                const accepted = await updateUsers((users, userData) => {
                    const recipient = users.find(user => user.email === recipientEmail);
                    if (!recipient || !Array.isArray(userData.requests)) {
                        return false;
                    }

                    const profileRequest = userData.requests.find(request =>
                        request.id === requestId
                        && request.toId === recipient.id
                        && request.status === "pending"
                    );
                    if (!profileRequest) {
                        return false;
                    }

                    profileRequest.status = "accepted";
                    profileRequest.acceptedAt = new Date().toISOString();
                    const participantIds = [profileRequest.fromId, profileRequest.toId].sort();
                    userData.chats = Array.isArray(userData.chats) ? userData.chats : [];
                    const existingChat = userData.chats.some(chat =>
                        Array.isArray(chat.participantIds)
                        && chat.participantIds.length === participantIds.length
                        && chat.participantIds.every((id, index) => id === participantIds[index])
                    );
                    if (!existingChat) {
                        userData.chats.push({
                            id: randomUUID(),
                            participantIds,
                            createdAt: profileRequest.acceptedAt,
                            messages: []
                        });
                    }
                    return true;
                });
                if (!accepted) {
                    sendJson(response, 404, { error: "Pending request not found." });
                    return;
                }

                sendJson(response, 200, { ok: true });
                return;
            }

            if (request.method === "GET" && url.pathname === "/api/chats") {
                const email = (url.searchParams.get("email") || "").trim().toLowerCase();
                if (!email) {
                    sendJson(response, 400, { error: "Email is required." });
                    return;
                }

                const userData = await ensureAcceptedChats();
                const user = userData.users.find(entry => entry.email === email);
                if (!user) {
                    sendJson(response, 404, { error: "User not found." });
                    return;
                }

                const usersById = new Map(userData.users.map(entry => [entry.id, entry]));
                const chats = (Array.isArray(userData.chats) ? userData.chats : [])
                    .filter(chat => chat.participantIds.includes(user.id))
                    .map(chat => {
                        const peerId = chat.participantIds.find(id => id !== user.id);
                        const peer = usersById.get(peerId);
                        if (!peer) {
                            return null;
                        }

                        const lastMessage = Array.isArray(chat.messages) && chat.messages.length
                            ? chat.messages[chat.messages.length - 1]
                            : null;
                        const peerUsername = typeof peer.username === "string" ? peer.username.trim() : "";
                        return {
                            id: chat.id,
                            username: peerUsername && peerUsername.toLowerCase() !== peer.email.toLowerCase()
                                ? peerUsername
                                : "Användare",
                            profilePicture: typeof peer.profilePicture === "string"
                                ? peer.profilePicture
                                : null,
                            canSendMessage: !(Array.isArray(userData.userBlocks)
                                && userData.userBlocks.some(block =>
                                    block.reporterId === peer.id && block.blockedUserId === user.id)),
                            lastMessage: lastMessage ? lastMessage.text : "",
                            updatedAt: lastMessage ? lastMessage.createdAt : chat.createdAt
                        };
                    })
                    .filter(Boolean)
                    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
                sendJson(response, 200, { chats });
                return;
            }

            const chatMessagesMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/messages$/);
            if (chatMessagesMatch && request.method === "GET") {
                const email = (url.searchParams.get("email") || "").trim().toLowerCase();
                if (!email) {
                    sendJson(response, 400, { error: "Email is required." });
                    return;
                }

                const userData = await ensureAcceptedChats();
                const user = userData.users.find(entry => entry.email === email);
                const chat = (Array.isArray(userData.chats) ? userData.chats : [])
                    .find(entry => entry.id === chatMessagesMatch[1]);
                if (!user || !chat || !chat.participantIds.includes(user.id)) {
                    sendJson(response, 404, { error: "Chat not found." });
                    return;
                }

                const messages = (Array.isArray(chat.messages) ? chat.messages : []).map(message => ({
                    id: message.id,
                    senderId: message.senderId,
                    text: message.text,
                    createdAt: message.createdAt
                }));
                const peerId = chat.participantIds.find(id => id !== user.id);
                const canSendMessage = !(Array.isArray(userData.userBlocks)
                    && userData.userBlocks.some(block =>
                        block.reporterId === peerId && block.blockedUserId === user.id));
                sendJson(response, 200, { userId: user.id, canSendMessage, messages });
                return;
            }

            if (chatMessagesMatch && request.method === "POST") {
                const body = await readRequestBody(request);
                const email = body && typeof body.email === "string"
                    ? body.email.trim().toLowerCase()
                    : "";
                const text = body && typeof body.text === "string" ? body.text.trim() : "";
                if (!email || !text) {
                    sendJson(response, 400, { error: "Email and a non-empty message are required." });
                    return;
                }
                if (text.length > 2000) {
                    sendJson(response, 413, { error: "Message is too long." });
                    return;
                }

                const message = await updateUsers((users, userData) => {
                    const sender = users.find(user => user.email === email);
                    const chat = (Array.isArray(userData.chats) ? userData.chats : [])
                        .find(entry => entry.id === chatMessagesMatch[1]);
                    if (!sender || !chat || !chat.participantIds.includes(sender.id)) {
                        return null;
                    }

                    const peerId = chat.participantIds.find(id => id !== sender.id);
                    const isBlocked = (Array.isArray(userData.userBlocks) ? userData.userBlocks : [])
                        .some(block => block.reporterId === peerId && block.blockedUserId === sender.id);
                    if (isBlocked) {
                        return { blocked: true };
                    }

                    chat.messages = Array.isArray(chat.messages) ? chat.messages : [];
                    const savedMessage = {
                        id: randomUUID(),
                        senderId: sender.id,
                        text,
                        createdAt: new Date().toISOString()
                    };
                    chat.messages.push(savedMessage);
                    userData.chatLogs = Array.isArray(userData.chatLogs) ? userData.chatLogs : [];
                    userData.chatLogs.push({
                        ...savedMessage,
                        chatId: chat.id,
                        senderName: typeof sender.username === "string"
                            ? sender.username.trim()
                            : "Användare"
                    });
                    return { message: savedMessage };
                });
                if (message && message.blocked) {
                    sendJson(response, 403, { error: "You cannot message this user because they reported you." });
                    return;
                }
                if (!message || !message.message) {
                    sendJson(response, 404, { error: "Chat not found." });
                    return;
                }

                sendJson(response, 201, { message: message.message });
                return;
            }

            if (request.method === "POST" && url.pathname === "/api/users/profile") {
                const body = await readRequestBody(request);
                const email = body && typeof body.email === "string"
                    ? body.email.trim().toLowerCase()
                    : "";
                const profilePicture = body && typeof body.profilePicture === "string"
                    ? body.profilePicture
                    : "";
                if (!email || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(profilePicture)) {
                    sendJson(response, 400, { error: "A valid email and JPEG profile picture are required." });
                    return;
                }
                if (profilePicture.length > MAX_PROFILE_PICTURE_LENGTH) {
                    sendJson(response, 413, { error: "Profile picture is too large." });
                    return;
                }

                const updated = await updateUsers(users => {
                    const user = users.find(entry => entry.email === email);
                    if (!user) {
                        return false;
                    }
                    user.profilePicture = profilePicture;
                    return true;
                });
                if (!updated) {
                    sendJson(response, 404, { error: "User not found." });
                    return;
                }

                sendJson(response, 200, { ok: true });
                return;
            }

            if (request.method === "POST" && url.pathname === "/api/users/logout") {
                const body = await readRequestBody(request);
                const email = body && typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
                if (!email) {
                    sendJson(response, 400, { error: "Email is required." });
                    return;
                }

                await updateUsers(users => {
                    const user = users.find(entry => entry.email === email);
                    if (user) {
                        user.active = false;
                    }
                });
                sendJson(response, 200, { ok: true });
                return;
            }

            if (request.method === "DELETE" && url.pathname.startsWith("/api/users/")) {
                let email;
                try {
                    email = decodeURIComponent(url.pathname.slice("/api/users/".length)).trim().toLowerCase();
                } catch {
                    sendJson(response, 400, { error: "Invalid email." });
                    return;
                }
                if (!email) {
                    sendJson(response, 400, { error: "Email is required." });
                    return;
                }

                const deleted = await updateUsers((users, userData) => {
                    const index = users.findIndex(user => user.email === email);
                    if (index === -1) {
                        return false;
                    }
                    const deletedUser = users[index];
                    users.splice(index, 1);
                    if (Array.isArray(userData.requests)) {
                        userData.requests = userData.requests.filter(request =>
                            request.fromId !== deletedUser.id && request.toId !== deletedUser.id
                        );
                    }
                    if (Array.isArray(userData.chats)) {
                        userData.chats = userData.chats.filter(chat =>
                            !chat.participantIds.includes(deletedUser.id)
                        );
                    }
                    return true;
                });
                if (!deleted) {
                    sendJson(response, 404, { error: "User not found." });
                    return;
                }
                sendJson(response, 200, { ok: true });
                return;
            }

            if (url.pathname.startsWith("/api/")) {
                sendJson(response, 404, { error: "Not found." });
                return;
            }

            if (request.method !== "GET" && request.method !== "HEAD") {
                sendJson(response, 405, { error: "Method not allowed." });
                return;
            }
            serveStaticFile(request, response, url.pathname);
        } catch (error) {
            if (!error.statusCode || error.statusCode >= 500) {
                console.error("API request failed:", error);
            }
            sendJson(response, error.statusCode || 500, {
                error: error.statusCode && error.statusCode < 500
                    ? error.message
                    : "The request could not be completed."
            });
        }
    });
}

if (require.main === module) {
    createServer().listen(PORT, "0.0.0.0", () => {
        console.log(`LBSradarn is running at http://localhost:${PORT}`);
    });
}

module.exports = { createServer };
