const ADMIN_TOKEN_KEY = "lbsradarn.adminToken";
const loginPanel = document.getElementById("admin-login-panel");
const reportsPanel = document.getElementById("admin-reports-panel");
const loginForm = document.getElementById("admin-login-form");
const tokenInput = document.getElementById("admin-token");
const loginStatus = document.getElementById("admin-login-status");
const reportsStatus = document.getElementById("admin-reports-status");
const reportsList = document.getElementById("admin-reports-list");
const logoutButton = document.getElementById("admin-logout");
const refreshButton = document.getElementById("refresh-reports");

function showLogin() {
    loginPanel.hidden = false;
    reportsPanel.hidden = true;
    logoutButton.hidden = true;
}

function showReports() {
    loginPanel.hidden = true;
    reportsPanel.hidden = false;
    logoutButton.hidden = false;
}

async function adminRequest(url, options = {}) {
    const token = sessionStorage.getItem(ADMIN_TOKEN_KEY);
    const headers = {
        ...(options.headers || {}),
        Authorization: `Bearer ${token || ""}`
    };
    const response = await fetch(url, { ...options, headers });
    const result = await response.json();
    if (response.status === 401) {
        sessionStorage.removeItem(ADMIN_TOKEN_KEY);
        showLogin();
        throw new Error("Adminnyckeln är fel eller har gått ut.");
    }
    if (!response.ok) {
        throw new Error(result.error || `Servern svarade med status ${response.status}.`);
    }
    return result;
}

function formatReportTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Okänt datum" : date.toLocaleString("sv-SE");
}

function appendReportLog(container, report) {
    const details = document.createElement("details");
    details.className = "report-log-details";
    const summary = document.createElement("summary");
    summary.textContent = `Visa chattlogg (${report.chatLog.length} meddelanden)`;
    details.append(summary);

    const log = document.createElement("div");
    log.className = "report-log";
    const names = new Map((report.participants || []).map(user => [user.id, user.username]));
    report.chatLog.forEach(function(message) {
        const entry = document.createElement("div");
        entry.className = "report-log-entry";
        const sender = document.createElement("strong");
        sender.textContent = names.get(message.senderId) || message.senderName || "Användare";
        const text = document.createElement("p");
        text.textContent = message.text;
        const time = document.createElement("time");
        time.dateTime = message.createdAt || "";
        time.textContent = formatReportTime(message.createdAt);
        entry.append(sender, text, time);
        log.append(entry);
    });
    if (!report.chatLog.length) {
        const empty = document.createElement("p");
        empty.textContent = "Det finns inga sparade meddelanden i loggen.";
        log.append(empty);
    }
    details.append(log);
    container.append(details);
}

function renderReports(reports) {
    reportsList.replaceChildren();
    if (!reports.length) {
        reportsStatus.textContent = "Det finns inga anmälningar ännu.";
        return;
    }

    reportsStatus.textContent = `${reports.length} anmälningar`;
    reports.forEach(function(report) {
        const card = document.createElement("article");
        card.className = "report-card";

        const header = document.createElement("div");
        header.className = "report-card-header";
        const title = document.createElement("h3");
        title.textContent = report.targetType === "profile"
            ? `Profilbild: ${report.reportedUsername}`
            : `Chattmeddelande: ${report.reportedUsername}`;
        const status = document.createElement("span");
        status.className = "report-status";
        status.textContent = report.status === "open"
            ? "Öppen"
            : report.status === "reviewed"
            ? "Granskad"
            : "Avfärdad";
        header.append(title, status);

        const metadata = document.createElement("p");
        metadata.textContent =
            `Anmäld av ${report.reporterName} · ${report.reason} · ${formatReportTime(report.createdAt)}`;
        const details = document.createElement("p");
        details.textContent = report.details || "Ingen extra beskrivning.";
        card.append(header, metadata, details);

        if (report.targetType === "profile") {
            if (report.profilePicture) {
                const image = document.createElement("img");
                image.src = report.profilePicture;
                image.alt = `Anmäld profilbild för ${report.reportedUsername}`;
                image.onerror = function() {
                    image.onerror = null;
                    image.alt = "Profilbilden kunde inte visas.";
                };
                card.append(image);
            } else {
                const noImage = document.createElement("p");
                noImage.textContent = "Användaren hade ingen egen profilbild.";
                card.append(noImage);
            }
        } else {
            const reportedMessage = document.createElement("blockquote");
            reportedMessage.textContent = report.messageText || "Det rapporterade meddelandet saknas.";
            card.append(reportedMessage);
            appendReportLog(card, report);
        }

        const actions = document.createElement("div");
        actions.className = "report-card-actions";
        [["reviewed", "Markera granskad"], ["dismissed", "Avfärda"], ["open", "Öppna igen"]]
            .filter(([nextStatus]) => nextStatus !== report.status)
            .forEach(([nextStatus, label]) => {
                const button = document.createElement("button");
                button.type = "button";
                button.textContent = label;
                button.addEventListener("click", () => updateReportStatus(report.id, nextStatus));
                actions.append(button);
            });
        card.append(actions);
        reportsList.append(card);
    });
}

async function loadReports() {
    reportsStatus.textContent = "Hämtar anmälningar...";
    try {
        const result = await adminRequest("/api/admin/reports");
        if (!Array.isArray(result.reports)) {
            throw new Error("Servern returnerade en ogiltig lista med anmälningar.");
        }
        showReports();
        renderReports(result.reports);
    } catch (error) {
        console.error("Kunde inte hämta anmälningar:", error);
        reportsStatus.textContent = error.message;
    }
}

async function updateReportStatus(reportId, status) {
    try {
        await adminRequest(`/api/admin/reports/${encodeURIComponent(reportId)}/status`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status })
        });
        await loadReports();
    } catch (error) {
        console.error("Kunde inte uppdatera anmälan:", error);
        reportsStatus.textContent = error.message;
    }
}

loginForm.addEventListener("submit", async function(event) {
    event.preventDefault();
    const token = tokenInput.value.trim();
    if (!token) {
        loginStatus.textContent = "Ange adminnyckeln.";
        return;
    }
    sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
    loginStatus.textContent = "Kontrollerar adminnyckeln...";
    await loadReports();
    if (!reportsPanel.hidden) {
        tokenInput.value = "";
    } else {
        loginStatus.textContent = reportsStatus.textContent || "Admininloggningen misslyckades.";
    }
});

logoutButton.addEventListener("click", function() {
    sessionStorage.removeItem(ADMIN_TOKEN_KEY);
    showLogin();
    loginStatus.textContent = "Du har loggat ut.";
});

refreshButton.addEventListener("click", loadReports);

if (window.location.protocol === "file:") {
    loginForm.hidden = true;
    loginStatus.textContent = "Öppna adminsidan via http://localhost:3006/admin.html medan servern körs. Öppna inte admin.html som en lokal fil.";
} else if (sessionStorage.getItem(ADMIN_TOKEN_KEY)) {
    loadReports();
}
