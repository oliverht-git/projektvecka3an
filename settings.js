const account = getActiveAccount();
const usernameInput = document.getElementById("change-username");
const settingsForm = document.getElementById("settings-form");

if (account) {
    usernameInput.value = account.username;
}

settingsForm.addEventListener("submit", function(event) {
    event.preventDefault();

    const username = usernameInput.value.trim();
    if (username.length < 3 || username.length > 20) {
        alert("Användarnamnet måste vara mellan 3 och 20 tecken.");
        return;
    }

    if (!account) {
        alert("Du måste logga in för att ändra användarnamn.");
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

document.getElementById("logout-button").addEventListener("click", function() {
    localStorage.removeItem(ACTIVE_ACCOUNT_KEY);
    window.location.href = "index.html";
});