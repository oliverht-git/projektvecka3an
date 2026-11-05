const account = getActiveAccount();
const usernameInput = document.getElementById("change-username");
const settingsForm = document.getElementById("settings-form");

if (account && usernameInput && settingsForm) {
    usernameInput.value = account.username;

    settingsForm.addEventListener("submit", function(event) {
        event.preventDefault();

        const username = usernameInput.value.trim();
        if (username.length < 3 || username.length > 20) {
            alert("Användarnamnet måste vara mellan 3 och 20 tecken.");
            return;
        }

        try {
            account.username = username;
            saveActiveAccount(account);
            displayname();
            alert("Användarnamnet har uppdaterats.");
        } catch (error) {
            console.error("Kunde inte uppdatera användarnamnet:", error);
            alert("Användarnamnet kunde inte uppdateras. Försök igen.");
        }
    });
}

document.getElementById("logout-button").addEventListener("click", async function() {
    try {
        if (account) {
            const response = await fetch("/api/users/logout", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: account.email })
            });
            if (!response.ok) {
                throw new Error(`Could not record logout: ${response.status}`);
            }
        }

        localStorage.removeItem(ACTIVE_ACCOUNT_KEY);
        window.location.href = "index.html";
    } catch (error) {
        console.error("Kunde inte logga ut:", error);
        alert("Utloggningen kunde inte genomföras. Försök igen.");
    }
});

document.getElementById("delete-account-button").addEventListener("click", async function() {
    if (!account) {
        alert("Du måste logga in för att radera ditt konto.");
        return;
    }

    if (!window.confirm("Är du säker på att du vill radera ditt konto? Detta går inte att ångra.")) {
        return;
    }

    try {
        const response = await fetch(`/api/users/${encodeURIComponent(account.email)}`, {
            method: "DELETE"
        });
        if (!response.ok) {
            throw new Error(`Could not delete account: ${response.status}`);
        }

        localStorage.removeItem(ACCOUNT_STORAGE_PREFIX + account.email);
        localStorage.removeItem(ACTIVE_ACCOUNT_KEY);
        window.location.href = "index.html";
    } catch (error) {
        console.error("Kunde inte radera kontot:", error);
        alert("Kontot kunde inte raderas. Försök igen.");
    }
});



