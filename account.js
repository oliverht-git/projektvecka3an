const ACCOUNT_STORAGE_PREFIX = "lbsradarn.passwordHash:";
const ACTIVE_ACCOUNT_KEY = "lbsradarn.activeAccount";

function getActiveAccount() {
    const email = localStorage.getItem(ACTIVE_ACCOUNT_KEY);
    if (!email) {
        return null;
    }

    const storedAccount = localStorage.getItem(ACCOUNT_STORAGE_PREFIX + email);
    if (!storedAccount) {
        return null;
    }

    let account;
    try {
        account = JSON.parse(storedAccount);
    } catch {
        account = { passwordHash: storedAccount };
    }

    if (!account || typeof account !== "object") {
        throw new Error("Stored account has an invalid format.");
    }

    return {
        email: email,
        ...account,
        username: typeof account.username === "string"
            ? account.username
            : localStorage.getItem("username") || ""
    };
}

function saveActiveAccount(account) {
    const { email, ...accountData } = account;
    localStorage.setItem(ACCOUNT_STORAGE_PREFIX + email, JSON.stringify(accountData));
}

function displayname() {
    const displayName = document.getElementById("display-name");
    if (!displayName) {
        return;
    }

    const account = getActiveAccount();
    displayName.textContent = account ? account.username : "";
}

displayname();



