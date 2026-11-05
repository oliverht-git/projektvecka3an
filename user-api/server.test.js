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
    process.env.ADMIN_TOKEN = "test-admin-token";
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

test("reports profile pictures and chat messages and protects the admin report log", async () => {
    for (const [email, username] of [
        ["reporter@example.com", "Reporter"],
        ["reported@example.com", "Reported User"]
    ]) {
        const loginResponse = await fetch(`${baseUrl}/api/users/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, username })
        });
        assert.equal(loginResponse.status, 200);
    }

    const profilePicture = "data:image/jpeg;base64,/9j/2Q==";
    const pictureResponse = await fetch(`${baseUrl}/api/users/profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "reported@example.com", profilePicture })
    });
    assert.equal(pictureResponse.status, 200);

    const profilesResponse = await fetch(
        `${baseUrl}/api/users/profiles?exclude=${encodeURIComponent("reporter@example.com")}`
    );
    const { profiles } = await profilesResponse.json();
    const reportedProfile = profiles.find(profile => profile.username === "Reported User");
    assert.ok(reportedProfile);

    const requestResponse = await fetch(`${baseUrl}/api/users/requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromEmail: "reporter@example.com", toId: reportedProfile.id })
    });
    assert.equal(requestResponse.status, 200);
    const incomingResponse = await fetch(
        `${baseUrl}/api/users/requests?email=${encodeURIComponent("reported@example.com")}`
    );
    const { requests } = await incomingResponse.json();
    const acceptResponse = await fetch(`${baseUrl}/api/users/requests/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "reported@example.com", requestId: requests[0].id })
    });
    assert.equal(acceptResponse.status, 200);

    const chatsResponse = await fetch(
        `${baseUrl}/api/chats?email=${encodeURIComponent("reporter@example.com")}`
    );
    const { chats } = await chatsResponse.json();
    const chatUrl = `${baseUrl}/api/chats/${chats[0].id}/messages`;
    for (const [email, text] of [
        ["reporter@example.com", "Tidigare meddelande"],
        ["reported@example.com", "Meddelandet som anmäls"]
    ]) {
        const messageResponse = await fetch(chatUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, text })
        });
        assert.equal(messageResponse.status, 201);
    }
    const chatMessagesResponse = await fetch(
        `${chatUrl}?email=${encodeURIComponent("reporter@example.com")}`
    );
    const { messages } = await chatMessagesResponse.json();
    const reportedMessage = messages.find(message => message.text === "Meddelandet som anmäls");
    assert.ok(reportedMessage);

    const messageReportResponse = await fetch(`${baseUrl}/api/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            reporterEmail: "reporter@example.com",
            targetType: "message",
            targetId: reportedMessage.id,
            reason: "trakasserier",
            details: "Anmält chattmeddelande"
        })
    });
    assert.equal(messageReportResponse.status, 201);

    const blockedMessageResponse = await fetch(chatUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "reported@example.com", text: "Det här ska blockeras" })
    });
    assert.equal(blockedMessageResponse.status, 403);
    const reporterMessageResponse = await fetch(chatUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "reporter@example.com", text: "Det här tillåts" })
    });
    assert.equal(reporterMessageResponse.status, 201);
    const reporterChatListResponse = await fetch(
        `${baseUrl}/api/chats?email=${encodeURIComponent("reporter@example.com")}`
    );
    assert.equal((await reporterChatListResponse.json()).chats[0].canSendMessage, true);
    const reportedChatListResponse = await fetch(
        `${baseUrl}/api/chats?email=${encodeURIComponent("reported@example.com")}`
    );
    assert.equal((await reportedChatListResponse.json()).chats[0].canSendMessage, false);

    const profileReportResponse = await fetch(`${baseUrl}/api/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            reporterEmail: "reporter@example.com",
            targetType: "profile",
            targetId: reportedProfile.id,
            reason: "olämplig profilbild",
            details: "Anmäld profilbild"
        })
    });
    assert.equal(profileReportResponse.status, 201);

    const unauthorizedResponse = await fetch(`${baseUrl}/api/admin/reports`);
    assert.equal(unauthorizedResponse.status, 401);
    const invalidTokenResponse = await fetch(`${baseUrl}/api/admin/reports`, {
        headers: { Authorization: "Bearer wrong-token" }
    });
    assert.equal(invalidTokenResponse.status, 401);

    const adminResponse = await fetch(`${baseUrl}/api/admin/reports`, {
        headers: { Authorization: "Bearer test-admin-token" }
    });
    assert.equal(adminResponse.status, 200);
    assert.equal(adminResponse.headers.get("cache-control"), "no-store");
    const { reports } = await adminResponse.json();
    const profileReport = reports.find(report => report.targetType === "profile");
    const messageReport = reports.find(report => report.targetType === "message");
    assert.equal(profileReport.profilePicture, profilePicture);
    assert.equal(messageReport.messageText, "Meddelandet som anmäls");
    assert.deepEqual(
        messageReport.chatLog.map(message => message.text),
        ["Tidigare meddelande", "Meddelandet som anmäls", "Det här tillåts"]
    );
    const usersResponse = await fetch(`${baseUrl}/api/admin/users`, {
        headers: { Authorization: "Bearer test-admin-token" }
    });
    assert.equal(usersResponse.status, 200);
    const { users } = await usersResponse.json();
    assert.equal(users.some(user => user.id === reportedProfile.id), true);
    assert.equal(users.find(user => user.id === reportedProfile.id).reportCount, 2);

    const statusResponse = await fetch(
        `${baseUrl}/api/admin/reports/${encodeURIComponent(messageReport.id)}/status`,
        {
            method: "POST",
            headers: {
                Authorization: "Bearer test-admin-token",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ status: "reviewed" })
        }
    );
    assert.equal(statusResponse.status, 200);

    const dismissResponse = await fetch(
        `${baseUrl}/api/admin/reports/${encodeURIComponent(messageReport.id)}/status`,
        {
            method: "POST",
            headers: {
                Authorization: "Bearer test-admin-token",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ status: "dismissed" })
        }
    );
    assert.equal(dismissResponse.status, 200);
    const stillBlockedResponse = await fetch(chatUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "reported@example.com", text: "En annan anmälan är fortfarande aktiv" })
    });
    assert.equal(stillBlockedResponse.status, 403);
    const dismissProfileResponse = await fetch(
        `${baseUrl}/api/admin/reports/${encodeURIComponent(profileReport.id)}/status`,
        {
            method: "POST",
            headers: {
                Authorization: "Bearer test-admin-token",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ status: "dismissed" })
        }
    );
    assert.equal(dismissProfileResponse.status, 200);
    const unblockedMessageResponse = await fetch(chatUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "reported@example.com", text: "Anmälan nekades" })
    });
    assert.equal(unblockedMessageResponse.status, 201);

    const deleteResponse = await fetch(
        `${baseUrl}/api/admin/users/${encodeURIComponent(reportedProfile.id)}`,
        {
            method: "DELETE",
            headers: { Authorization: "Bearer test-admin-token" }
        }
    );
    assert.equal(deleteResponse.status, 200);
    const usersAfterDeleteResponse = await fetch(`${baseUrl}/api/admin/users`, {
        headers: { Authorization: "Bearer test-admin-token" }
    });
    assert.equal(
        (await usersAfterDeleteResponse.json()).users.some(user => user.id === reportedProfile.id),
        false
    );
    const reportsAfterDeleteResponse = await fetch(`${baseUrl}/api/admin/reports`, {
        headers: { Authorization: "Bearer test-admin-token" }
    });
    const reportsAfterDelete = (await reportsAfterDeleteResponse.json()).reports;
    assert.equal(reportsAfterDelete.length, 2);
    assert.deepEqual(
        reportsAfterDelete.find(report => report.targetType === "message").chatLog
            .map(message => message.text),
        ["Tidigare meddelande", "Meddelandet som anmäls", "Det här tillåts", "Anmälan nekades"]
    );
});

test("generates and prints an admin key when one is not configured", async () => {
    const previousAdminToken = process.env.ADMIN_TOKEN;
    const previousConsoleLog = console.log;
    let startupMessage = "";
    let generatedServer;
    try {
        delete process.env.ADMIN_TOKEN;
        console.log = message => {
            startupMessage = message;
        };
        generatedServer = require("./server").createServer();
        await new Promise(resolve => generatedServer.listen(0, "127.0.0.1", resolve));

        const keyMatch = startupMessage.match(/^Adminnyckel \(kopiera denna\): ([a-f0-9]{64})$/);
        assert.ok(keyMatch, "server startup should print its generated admin key");
        const response = await fetch(
            `http://127.0.0.1:${generatedServer.address().port}/api/admin/reports`,
            { headers: { Authorization: `Bearer ${keyMatch[1]}` } }
        );
        assert.equal(response.status, 200);
    } finally {
        if (generatedServer && generatedServer.listening) {
            await new Promise((resolve, reject) => {
                generatedServer.close(error => error ? reject(error) : resolve());
            });
        }
        console.log = previousConsoleLog;
        if (previousAdminToken === undefined) {
            delete process.env.ADMIN_TOKEN;
        } else {
            process.env.ADMIN_TOKEN = previousAdminToken;
        }
    }
});
