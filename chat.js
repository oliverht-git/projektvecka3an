const CHAT_POLL_INTERVAL = 3000;
const account = getActiveAccount();
const conversationStatus = document.getElementById("conversation-status");
const conversationList = document.getElementById("conversation-list");
const emptyState = document.getElementById("chat-empty-state");
const activeChat = document.getElementById("active-chat");
const activeChatPicture = document.getElementById("active-chat-picture");
const activeChatName = document.getElementById("active-chat-name");
const messageList = document.getElementById("message-list");
const messageStatus = document.getElementById("message-status");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message-input");
const sendMessageButton = document.getElementById("send-message-button");

let chats = [];
let selectedChatId = new URLSearchParams(window.location.search).get("id");
let isLoadingChats = false;
let isLoadingMessages = false;
let isSendingMessage = false;
let canSendSelectedChat = true;

function formatMessageTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return "";
    }
    return date.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
}

function showChatStatus(message) {
    conversationStatus.textContent = message;
}

function renderConversations() {
    conversationList.replaceChildren();

    chats.forEach(function(chat) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "conversation-item";
        button.setAttribute("aria-current", String(chat.id === selectedChatId));
        button.addEventListener("click", function() {
            selectChat(chat);
        });

        const image = document.createElement("img");
        image.src = chat.profilePicture || "normalpfp.svg";
        image.alt = "";
        image.onerror = function() {
            image.onerror = null;
            image.src = "normalpfp.svg";
        };

        const details = document.createElement("span");
        details.className = "conversation-item-details";
        const name = document.createElement("span");
        name.className = "conversation-item-name";
        name.textContent = chat.username;
        const preview = document.createElement("span");
        preview.className = "conversation-item-preview";
        preview.textContent = chat.lastMessage || "Ingen meddelanden ännu";
        details.append(name, preview);
        button.append(image, details);
        conversationList.append(button);
    });
}

function selectChat(chat) {
    selectedChatId = chat.id;
    canSendSelectedChat = chat.canSendMessage !== false;
    messageForm.hidden = !canSendSelectedChat;
    messageStatus.textContent = canSendSelectedChat
        ? ""
        : "Du kan inte skriva till den här användaren eftersom hen har anmält dig.";
    emptyState.hidden = true;
    activeChat.hidden = false;
    activeChatName.textContent = chat.username;
    activeChatPicture.onerror = function() {
        activeChatPicture.onerror = null;
        activeChatPicture.src = "normalpfp.svg";
    };
    activeChatPicture.src = chat.profilePicture || "normalpfp.svg";
    messageStatus.textContent = "";
    history.replaceState(null, "", `chatt.html?id=${encodeURIComponent(chat.id)}`);
    renderConversations();
    loadMessages();
}

async function loadChats() {
    if (!account || isLoadingChats) {
        return;
    }

    isLoadingChats = true;
    try {
        const response = await fetch(`/api/chats?email=${encodeURIComponent(account.email)}`);
        if (!response.ok) {
            throw new Error(`Servern svarade med status ${response.status}.`);
        }

        const result = await response.json();
        if (!Array.isArray(result.chats)) {
            throw new Error("Servern returnerade en ogiltig konversationslista.");
        }
        chats = result.chats;
        showChatStatus(chats.length ? "" : "Du har inga konversationer ännu. Acceptera en förfrågan för att börja chatta.");

        const selectedChat = chats.find(chat => chat.id === selectedChatId);
        if (selectedChat) {
            canSendSelectedChat = selectedChat.canSendMessage !== false;
            messageForm.hidden = !canSendSelectedChat;
            if (!canSendSelectedChat) {
                messageStatus.textContent = "Du kan inte skriva till den här användaren eftersom hen har anmält dig.";
            }
            activeChatName.textContent = selectedChat.username;
            activeChatPicture.src = selectedChat.profilePicture || "normalpfp.svg";
            emptyState.hidden = true;
            activeChat.hidden = false;
        } else if (chats.length && !selectedChatId) {
            selectChat(chats[0]);
        } else if (!selectedChat) {
            selectedChatId = null;
            activeChat.hidden = true;
            emptyState.hidden = false;
            history.replaceState(null, "", "chatt.html");
        }

        renderConversations();
    } catch (error) {
        console.error("Kunde inte hämta konversationerna:", error);
        showChatStatus("Konversationerna kunde inte laddas. Försök igen.");
    } finally {
        isLoadingChats = false;
    }
}

async function loadMessages() {
    if (!account || !selectedChatId || isLoadingMessages) {
        return;
    }

    isLoadingMessages = true;
    try {
        const response = await fetch(
            `/api/chats/${encodeURIComponent(selectedChatId)}/messages?email=${encodeURIComponent(account.email)}`
        );
        if (!response.ok) {
            throw new Error(`Servern svarade med status ${response.status}.`);
        }

        const result = await response.json();
        if (!Array.isArray(result.messages) || typeof result.userId !== "string"
            || typeof result.canSendMessage !== "boolean") {
            throw new Error("Servern returnerade en ogiltig meddelandelista.");
        }

        const lastMessage = result.messages[result.messages.length - 1];
        if (lastMessage) {
            try {
                localStorage.setItem(
                    `lbsradarn.lastReadMessage:${account.email}:${selectedChatId}`,
                    lastMessage.id
                );
            } catch (error) {
                console.error("Kunde inte spara lästa meddelanden:", error);
            }
        }

        canSendSelectedChat = result.canSendMessage;
        messageForm.hidden = !canSendSelectedChat;
        if (!canSendSelectedChat) {
            messageStatus.textContent = "Du kan inte skriva till den här användaren eftersom hen har anmält dig.";
        }
        const wasAtBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 48;
        const previousLastMessage = messageList.lastElementChild && messageList.lastElementChild.dataset.messageId;
        messageList.replaceChildren();
        result.messages.forEach(function(message) {
            const bubble = document.createElement("article");
            bubble.className = message.senderId === result.userId
                ? "message-bubble own-message"
                : "message-bubble";
            bubble.dataset.messageId = message.id;

            const text = document.createElement("span");
            text.textContent = message.text;
            const time = document.createElement("time");
            time.className = "message-time";
            time.dateTime = message.createdAt;
            time.textContent = formatMessageTime(message.createdAt);
            bubble.append(text, time);
            if (message.senderId !== result.userId) {
                const reportButton = document.createElement("button");
                reportButton.type = "button";
                reportButton.className = "report-button report-message-button";
                reportButton.textContent = "Anmäl meddelande";
                reportButton.dataset.reportType = "message";
                reportButton.dataset.reportTargetId = message.id;
                reportButton.dataset.reportTargetName = activeChatName.textContent;
                bubble.append(reportButton);
            }
            messageList.append(bubble);
        });

        if (wasAtBottom || (result.messages.length
            && result.messages[result.messages.length - 1].id !== previousLastMessage)) {
            messageList.scrollTop = messageList.scrollHeight;
        }
        if (canSendSelectedChat) {
            messageStatus.textContent = "";
        }
    } catch (error) {
        console.error("Kunde inte hämta meddelanden:", error);
        messageStatus.textContent = "Meddelandena kunde inte laddas. Försök igen.";
    } finally {
        isLoadingMessages = false;
    }
}

messageForm.addEventListener("submit", async function(event) {
    event.preventDefault();
    const text = messageInput.value.trim();
    if (!text || !selectedChatId || isSendingMessage || !canSendSelectedChat) {
        return;
    }

    isSendingMessage = true;
    sendMessageButton.disabled = true;
    messageStatus.textContent = "Skickar...";
    try {
        const response = await fetch(`/api/chats/${encodeURIComponent(selectedChatId)}/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: account.email, text })
        });
        if (!response.ok) {
            if (response.status === 403) {
                canSendSelectedChat = false;
                messageForm.hidden = true;
                messageStatus.textContent = "Du kan inte skriva till den här användaren eftersom hen har anmält dig.";
                return;
            }
            throw new Error(`Servern svarade med status ${response.status}.`);
        }

        messageInput.value = "";
        await loadMessages();
        await loadChats();
        messageInput.focus();
    } catch (error) {
        console.error("Kunde inte skicka meddelandet:", error);
        messageStatus.textContent = "Meddelandet kunde inte skickas. Försök igen.";
    } finally {
        isSendingMessage = false;
        sendMessageButton.disabled = false;
    }
});

if (!account) {
    showChatStatus("Logga in för att chatta.");
    messageForm.hidden = true;
} else {
    loadChats();
    window.setInterval(loadChats, CHAT_POLL_INTERVAL * 2);
    window.setInterval(loadMessages, CHAT_POLL_INTERVAL);
}
