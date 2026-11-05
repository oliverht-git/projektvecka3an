const notificationsStatus = document.getElementById("notifications-status");
const notificationsList = document.getElementById("notifications-list");
const NOTIFICATIONS_POLL_INTERVAL = 5000;
let isLoadingNotifications = false;

function formatNotificationTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return "";
    }

    return date.toLocaleString("sv-SE", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
    });
}

function createNotification(notification) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.className = "notification-link";
    link.href = notification.href;

    const title = document.createElement("span");
    title.textContent = notification.title;
    link.append(title);

    if (notification.preview) {
        const preview = document.createElement("span");
        preview.className = "notification-preview";
        preview.textContent = notification.preview;
        link.append(preview);
    }

    const timeLabel = formatNotificationTime(notification.createdAt);
    if (timeLabel) {
        const time = document.createElement("time");
        time.className = "notification-time";
        time.dateTime = notification.createdAt;
        time.textContent = timeLabel;
        link.append(time);
    }

    item.append(link);
    return item;
}

async function fetchNotificationData(account) {
    const [requestsResponse, chatsResponse] = await Promise.all([
        fetch(`/api/users/requests?email=${encodeURIComponent(account.email)}`),
        fetch(`/api/chats?email=${encodeURIComponent(account.email)}`)
    ]);

    if (!requestsResponse.ok || !chatsResponse.ok) {
        throw new Error(
            `Notiser kunde inte hämtas (förfrågningar: ${requestsResponse.status}, chattar: ${chatsResponse.status}).`
        );
    }

    const [requestsResult, chatsResult] = await Promise.all([
        requestsResponse.json(),
        chatsResponse.json()
    ]);
    if (!Array.isArray(requestsResult.requests) || !Array.isArray(chatsResult.chats)) {
        throw new Error("Servern returnerade en ogiltig notislista.");
    }

    return { requests: requestsResult.requests, chats: chatsResult.chats };
}

async function loadNotifications() {
    if (isLoadingNotifications) {
        return;
    }

    isLoadingNotifications = true;
    try {
        const account = getActiveAccount();
        if (!account) {
            notificationsList.replaceChildren();
            notificationsStatus.textContent = "Logga in för att se dina notiser.";
            return;
        }

        const { requests, chats } = await fetchNotificationData(account);
        const notifications = requests.map(function(request) {
            return {
                href: "profil.html",
                title: `${request.username} skickade en vänförfrågan.`,
                createdAt: request.createdAt
            };
        });

        chats.forEach(function(chat) {
            const readMessageKey = `lbsradarn.lastReadMessage:${account.email}:${chat.id}`;
            const lastReadMessageId = localStorage.getItem(readMessageKey);
            if (!chat.lastMessageFromPeer || !chat.lastMessageId
                || lastReadMessageId === chat.lastMessageId) {
                return;
            }

            notifications.push({
                href: `chatt.html?id=${encodeURIComponent(chat.id)}`,
                title: `${chat.username} skickade ett meddelande.`,
                preview: chat.lastMessage,
                createdAt: chat.updatedAt
            });
        });

        notifications.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
        notificationsList.replaceChildren(...notifications.map(createNotification));
        notificationsStatus.textContent = notifications.length ? "" : "Du har inga nya notiser.";
    } catch (error) {
        console.error("Kunde inte hämta notiser:", error);
        notificationsStatus.textContent = "Notiserna kunde inte laddas. Försök igen.";
    } finally {
        isLoadingNotifications = false;
    }
}

loadNotifications();
window.setInterval(loadNotifications, NOTIFICATIONS_POLL_INTERVAL);
