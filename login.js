const PASSWORD_HASH_ITERATIONS = 600000;
const BCRYPT_ROUNDS = 10;
const ACCOUNT_STORAGE_PREFIX = "lbsradarn.passwordHash:";
let pendingAccount = null;

function getAccountKey(email) {
    return ACCOUNT_STORAGE_PREFIX + email.trim().toLowerCase();
}

function showScreen(screenId) {
    document.getElementById("signup-screen").hidden = screenId !== "signup-screen";
    document.getElementById("username-screen").hidden = screenId !== "username-screen";
    document.getElementById("login-screen").hidden = screenId !== "login-screen";
}

async function hashPassword(password) {
    if (typeof password !== "string" || password.length === 0) {
        throw new TypeError("Password must be a non-empty string.");
    }

    if (new TextEncoder().encode(password).length > 72) {
        throw new Error("Bcrypt passwords cannot exceed 72 bytes.");
    }

    const bcrypt = globalThis.dcodeIO && globalThis.dcodeIO.bcrypt;
    if (!bcrypt) {
        throw new Error("Bcrypt is unavailable.");
    }

    return new Promise((resolve, reject) => {
        bcrypt.hash(password, BCRYPT_ROUNDS, (error, hash) => {
            if (error) {
                reject(error);
            } else {
                resolve(hash);
            }
        });
    });
}

async function verifyLegacyPassword(password, encodedHash) {
    const [algorithm, iterations, saltBase64, expectedHashBase64] = encodedHash.split("$");
    if (algorithm !== "pbkdf2-sha256" || Number(iterations) !== PASSWORD_HASH_ITERATIONS || !saltBase64 || !expectedHashBase64) {
        throw new Error("Stored password hash has an invalid format.");
    }

    const salt = Uint8Array.from(atob(saltBase64), character => character.charCodeAt(0));
    const expectedHash = Uint8Array.from(atob(expectedHashBase64), character => character.charCodeAt(0));
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        "PBKDF2",
        false,
        ["deriveBits"]
    );
    const actualHash = new Uint8Array(await crypto.subtle.deriveBits(
        {
            name: "PBKDF2",
            salt: salt,
            iterations: PASSWORD_HASH_ITERATIONS,
            hash: "SHA-256"
        },
        key,
        256
    ));

    if (actualHash.length !== expectedHash.length) {
        return false;
    }

    let difference = 0;
    for (let index = 0; index < actualHash.length; index += 1) {
        difference |= actualHash[index] ^ expectedHash[index];
    }
    return difference === 0;
}

async function verifyPassword(password, encodedHash) {
    const bcrypt = globalThis.dcodeIO && globalThis.dcodeIO.bcrypt;
    if (!bcrypt) {
        throw new Error("Bcrypt is unavailable.");
    }

    if (new TextEncoder().encode(password).length > 72) {
        return false;
    }

    return new Promise((resolve, reject) => {
        bcrypt.compare(password, encodedHash, (error, matches) => {
            if (error) {
                reject(error);
            } else {
                resolve(matches);
            }
        });
    });
}

const signupForm = document.getElementById("signup-form");
signupForm.addEventListener("submit", async function(event) {
    event.preventDefault();

    const email = document.getElementById("create-username").value;
    const password = document.getElementById("create-password").value;
    const confirmPassword = document.getElementById("rpt-password").value;

    if (password !== confirmPassword) {
        alert("Lösenorden matchar inte.");
        return;
    }

    if (localStorage.getItem(getAccountKey(email))) {
        alert("Det finns redan ett konto med den e-postadressen.");
        return;
    }

    try {
        pendingAccount = {
            email: email.trim().toLowerCase(),
            passwordHash: await hashPassword(password)
        };
        showScreen("username-screen");
        document.getElementById("create-display-name").focus();
    } catch (error) {
        console.error("Kunde inte förbereda kontot:", error);
        alert("Kontot kunde inte förberedas. Försök igen.");
    }
});

const usernameForm = document.getElementById("username-form");
usernameForm.addEventListener("submit", function(event) {
    event.preventDefault();

    if (!pendingAccount) {
        showScreen("signup-screen");
        alert("Kontot kunde inte hittas. Börja om med att skapa ett konto.");
        return;
    }

    const username = document.getElementById("create-display-name").value.trim();
    if (username.length < 3 || username.length > 20) {
        alert("Användarnamnet måste vara mellan 3 och 20 tecken.");
        return;
    }

    try {
        const accountKey = getAccountKey(pendingAccount.email);
        if (localStorage.getItem(accountKey)) {
            alert("Det finns redan ett konto med den e-postadressen.");
            pendingAccount = null;
            showScreen("signup-screen");
            return;
        }

        const account = {
            username: username,
            passwordHash: pendingAccount.passwordHash
        };
        localStorage.setItem(accountKey, JSON.stringify(account));
        document.getElementById("user-username").value = pendingAccount.email;
        pendingAccount = null;
        signupForm.reset();
        usernameForm.reset();
        showScreen("login-screen");
        alert("Användarnamnet har sparats. Du kan nu logga in.");
    } catch (error) {
        console.error("Kunde inte spara kontot:", error);
        alert("Kontot kunde inte sparas. Försök igen.");
    }
});

const loginForm = document.getElementById("login-form");
loginForm.addEventListener("submit", async function(event) {
    event.preventDefault();

    const email = document.getElementById("user-username").value;
    const password = document.getElementById("user-password").value;
    const storedAccount = localStorage.getItem(getAccountKey(email));

    if (!storedAccount) {
        alert("Fel e-postadress eller lösenord.");
        return;
    }

    try {
        let account;
        try {
            account = JSON.parse(storedAccount);
        } catch {
            account = { passwordHash: storedAccount };
        }

        const passwordHash = account.passwordHash;
        if (typeof passwordHash !== "string") {
            throw new Error("Stored account has no password hash.");
        }

        const isLegacyHash = passwordHash.startsWith("pbkdf2-sha256$");
        const passwordMatches = isLegacyHash
            ? await verifyLegacyPassword(password, passwordHash)
            : await verifyPassword(password, passwordHash);
        if (passwordMatches) {
            if (isLegacyHash && new TextEncoder().encode(password).length <= 72) {
                account.passwordHash = await hashPassword(password);
                localStorage.setItem(getAccountKey(email), JSON.stringify(account));
            }
            window.location.href = "main.html";
        } else {
            alert("Fel e-postadress eller lösenord.");
        }
    } catch (error) {
        console.error("Kunde inte verifiera lösenord:", error);
        alert("Inloggningen kunde inte genomföras. Försök igen.");
    }
});
