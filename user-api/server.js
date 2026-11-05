const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const USER_FILE = process.env.USER_FILE || path.join(ROOT, "user.json");
const PORT = Number(process.env.PORT || 3006);
const MAX_BODY_SIZE = 16 * 1024;
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
        const result = update(userData.users);
        const temporaryFile = `${USER_FILE}.${process.pid}.tmp`;
        await fs.writeFile(temporaryFile, `${JSON.stringify(userData, null, 2)}\n`, "utf8");
        await fs.rename(temporaryFile, USER_FILE);
        return result;
    });
    updateQueue = operation.catch(() => {});
    return operation;
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
        ".json": "application/json; charset=utf-8"
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
                        existingUser.username = username;
                        existingUser.active = true;
                        existingUser.lastLogin = lastLogin;
                    } else {
                        users.push({ email, username, active: true, lastLogin });
                    }
                });
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

                const deleted = await updateUsers(users => {
                    const index = users.findIndex(user => user.email === email);
                    if (index === -1) {
                        return false;
                    }
                    users.splice(index, 1);
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
