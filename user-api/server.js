const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

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
    return http.createServer(async (request, response) => {
        const url = new URL(request.url, "http://localhost");
        try {
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
                const seenEmails = new Set();
                const seenIds = new Set();
                const profiles = userData.users
                    .filter(user => {
                        const email = typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
                        if (!email || email === excludedEmail || seenEmails.has(email) || seenIds.has(user.id)) {
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
                sendJson(response, 200, { userId: user.id, messages });
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

                    chat.messages = Array.isArray(chat.messages) ? chat.messages : [];
                    const savedMessage = {
                        id: randomUUID(),
                        senderId: sender.id,
                        text,
                        createdAt: new Date().toISOString()
                    };
                    chat.messages.push(savedMessage);
                    return savedMessage;
                });
                if (!message) {
                    sendJson(response, 404, { error: "Chat not found." });
                    return;
                }

                sendJson(response, 201, { message });
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
