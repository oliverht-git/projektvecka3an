const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

let temporaryDirectory;
let server;
let baseUrl;

before(async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "lbsradarn-users-"));
    process.env.USER_FILE = path.join(temporaryDirectory, "user.json");
    const { createServer } = require("./server");
    server = createServer();
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

test("records logins, logout status, and account deletion", async () => {
    const loginResponse = await fetch(`${baseUrl}/api/users/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "Test@Example.com", username: "Test User" })
    });
    assert.equal(loginResponse.status, 200);

    let userData = JSON.parse(await fs.readFile(process.env.USER_FILE, "utf8"));
    assert.equal(userData.users.length, 1);
    assert.equal(userData.users[0].email, "test@example.com");
    assert.equal(userData.users[0].username, "Test User");
    assert.equal(userData.users[0].active, true);
    assert.ok(Number.isFinite(Date.parse(userData.users[0].lastLogin)));

    const logoutResponse = await fetch(`${baseUrl}/api/users/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "test@example.com" })
    });
    assert.equal(logoutResponse.status, 200);
    userData = JSON.parse(await fs.readFile(process.env.USER_FILE, "utf8"));
    assert.equal(userData.users[0].active, false);

    const deleteResponse = await fetch(`${baseUrl}/api/users/${encodeURIComponent("test@example.com")}`, {
        method: "DELETE"
    });
    assert.equal(deleteResponse.status, 200);
    userData = JSON.parse(await fs.readFile(process.env.USER_FILE, "utf8"));
    assert.deepEqual(userData.users, []);
});

test("serves the app but not the user registry", async () => {
    const appResponse = await fetch(`${baseUrl}/`);
    assert.equal(appResponse.status, 200);
    assert.match(await appResponse.text(), /LBSradarn/);

    const registryResponse = await fetch(`${baseUrl}/user.json`);
    assert.equal(registryResponse.status, 404);
});

test("records older accounts that do not have a username", async () => {
    const response = await fetch(`${baseUrl}/api/users/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "legacy@example.com" })
    });
    assert.equal(response.status, 200);

    const userData = JSON.parse(await fs.readFile(process.env.USER_FILE, "utf8"));
    const user = userData.users.find(entry => entry.email === "legacy@example.com");
    assert.equal(user.username, "legacy@example.com");
    assert.equal(user.active, true);
});
