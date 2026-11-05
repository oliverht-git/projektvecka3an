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

    const avatarResponse = await fetch(`${baseUrl}/normalpfp.svg`);
    assert.equal(avatarResponse.status, 200);
    assert.match(avatarResponse.headers.get("content-type"), /^image\/svg\+xml/);

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

test("shares profile pictures without exposing user email addresses", async () => {
    for (const [email, username] of [
        ["viewer@example.com", "Viewer"],
        ["other@example.com", "Other User"]
    ]) {
        const loginResponse = await fetch(`${baseUrl}/api/users/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, username })
        });
        assert.equal(loginResponse.status, 200);
    }

    const profilePicture = "data:image/jpeg;base64,/9j/2Q==";
    const updateResponse = await fetch(`${baseUrl}/api/users/profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "other@example.com", profilePicture })
    });
    assert.equal(updateResponse.status, 200);

    const profilesResponse = await fetch(
        `${baseUrl}/api/users/profiles?exclude=${encodeURIComponent("viewer@example.com")}`
    );
    assert.equal(profilesResponse.status, 200);
    const result = await profilesResponse.json();
    assert.ok(result.profiles.some(profile => profile.username === "Other User"
        && profile.profilePicture === profilePicture));
    assert.equal(result.profiles.some(profile => profile.username === "Viewer"), false);
    assert.equal(JSON.stringify(result).includes("@"), false);
});

test("does not return duplicate accounts in the profile list", async () => {
    const loginResponse = await fetch(`${baseUrl}/api/users/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "duplicate@example.com", username: "Duplicate" })
    });
    assert.equal(loginResponse.status, 200);

    const userData = JSON.parse(await fs.readFile(process.env.USER_FILE, "utf8"));
    const originalAccount = userData.users.find(user => user.email === "duplicate@example.com");
    userData.users.push({
        ...originalAccount,
        id: "duplicate-account-record",
        active: false
    });
    await fs.writeFile(process.env.USER_FILE, `${JSON.stringify(userData, null, 2)}\n`, "utf8");

    const profilesResponse = await fetch(
        `${baseUrl}/api/users/profiles?exclude=${encodeURIComponent("viewer@example.com")}`
    );
    assert.equal(profilesResponse.status, 200);
    const { profiles } = await profilesResponse.json();
    assert.equal(profiles.filter(profile => profile.username === "Duplicate").length, 1);
});

test("sends profile requests and accepts them from the recipient profile", async () => {
    for (const [email, username] of [
        ["requester@example.com", "Requester"],
        ["recipient@example.com", "Recipient"]
    ]) {
        const loginResponse = await fetch(`${baseUrl}/api/users/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, username })
        });
        assert.equal(loginResponse.status, 200);
    }

    const profilesResponse = await fetch(
        `${baseUrl}/api/users/profiles?exclude=${encodeURIComponent("requester@example.com")}`
    );
    const { profiles } = await profilesResponse.json();
    const recipient = profiles.find(profile => profile.username === "Recipient");
    assert.ok(recipient && recipient.id);

    const sendResponse = await fetch(`${baseUrl}/api/users/requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromEmail: "requester@example.com", toId: recipient.id })
    });
    assert.equal(sendResponse.status, 200);
    assert.equal((await sendResponse.json()).status, "pending");

    const incomingResponse = await fetch(
        `${baseUrl}/api/users/requests?email=${encodeURIComponent("recipient@example.com")}`
    );
    assert.equal(incomingResponse.status, 200);
    const { requests } = await incomingResponse.json();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].username, "Requester");
    assert.equal(JSON.stringify(requests).includes("@"), false);

    const acceptResponse = await fetch(`${baseUrl}/api/users/requests/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "recipient@example.com", requestId: requests[0].id })
    });
    assert.equal(acceptResponse.status, 200);

    const afterAcceptResponse = await fetch(
        `${baseUrl}/api/users/requests?email=${encodeURIComponent("recipient@example.com")}`
    );
    assert.deepEqual((await afterAcceptResponse.json()).requests, []);

    const requesterChatsResponse = await fetch(
        `${baseUrl}/api/chats?email=${encodeURIComponent("requester@example.com")}`
    );
    const requesterChats = await requesterChatsResponse.json();
    assert.equal(requesterChats.chats.length, 1);
    assert.equal(requesterChats.chats[0].username, "Recipient");

    const recipientChatsResponse = await fetch(
        `${baseUrl}/api/chats?email=${encodeURIComponent("recipient@example.com")}`
    );
    const recipientChats = await recipientChatsResponse.json();
    assert.equal(recipientChats.chats.length, 1);
    assert.equal(recipientChats.chats[0].id, requesterChats.chats[0].id);

    const chatUrl = `${baseUrl}/api/chats/${requesterChats.chats[0].id}/messages`;
    const sendMessageResponse = await fetch(chatUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "requester@example.com", text: "Hej!" })
    });
    assert.equal(sendMessageResponse.status, 201);

    const recipientMessagesResponse = await fetch(
        `${chatUrl}?email=${encodeURIComponent("recipient@example.com")}`
    );
    const recipientMessages = await recipientMessagesResponse.json();
    assert.equal(recipientMessages.messages.length, 1);
    assert.equal(recipientMessages.messages[0].text, "Hej!");

    const unauthorizedResponse = await fetch(
        `${chatUrl}?email=${encodeURIComponent("outsider@example.com")}`
    );
    assert.equal(unauthorizedResponse.status, 404);
});

test("removes a friend and deletes the shared conversation for both users", async () => {
    for (const [email, username] of [
        ["friend-one@example.com", "Friend One"],
        ["friend-two@example.com", "Friend Two"]
    ]) {
        const loginResponse = await fetch(`${baseUrl}/api/users/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, username })
        });
        assert.equal(loginResponse.status, 200);
    }

    const profilesResponse = await fetch(
        `${baseUrl}/api/users/profiles?exclude=${encodeURIComponent("friend-one@example.com")}`
    );
    const { profiles } = await profilesResponse.json();
    const friend = profiles.find(profile => profile.username === "Friend Two");
    assert.ok(friend);

    const requestResponse = await fetch(`${baseUrl}/api/users/requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromEmail: "friend-one@example.com", toId: friend.id })
    });
    assert.equal(requestResponse.status, 200);

    const incomingResponse = await fetch(
        `${baseUrl}/api/users/requests?email=${encodeURIComponent("friend-two@example.com")}`
    );
    const { requests } = await incomingResponse.json();
    const acceptResponse = await fetch(`${baseUrl}/api/users/requests/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "friend-two@example.com", requestId: requests[0].id })
    });
    assert.equal(acceptResponse.status, 200);

    const chatsResponse = await fetch(
        `${baseUrl}/api/chats?email=${encodeURIComponent("friend-one@example.com")}`
    );
    const { chats } = await chatsResponse.json();
    assert.equal(chats.length, 1);
    const chatUrl = `${baseUrl}/api/chats/${chats[0].id}/messages`;
    const messageResponse = await fetch(chatUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "friend-one@example.com", text: "Hej!" })
    });
    assert.equal(messageResponse.status, 201);

    const removeResponse = await fetch(`${baseUrl}/api/users/friends/remove`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "friend-one@example.com", friendId: friend.id })
    });
    assert.equal(removeResponse.status, 200);

    for (const email of ["friend-one@example.com", "friend-two@example.com"]) {
        const friendsResponse = await fetch(
            `${baseUrl}/api/users/friends?email=${encodeURIComponent(email)}`
        );
        assert.deepEqual((await friendsResponse.json()).friends, []);

        const remainingChatsResponse = await fetch(`${baseUrl}/api/chats?email=${encodeURIComponent(email)}`);
        assert.deepEqual((await remainingChatsResponse.json()).chats, []);
    }

    const removedChatResponse = await fetch(
        `${chatUrl}?email=${encodeURIComponent("friend-two@example.com")}`
    );
    assert.equal(removedChatResponse.status, 404);
});
