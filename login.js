const PASSWORD_HASH_ITERATIONS = 600000;

async function hashPassword(password) {
    if (typeof password !== "string" || password.length === 0) {
        throw new TypeError("Password must be a non-empty string.");
    }

    if (!globalThis.crypto || !globalThis.crypto.subtle) {
        throw new Error("Password hashing requires Web Crypto in a secure context.");
    }

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        "PBKDF2",
        false,
        ["deriveBits"]
    );
    const hash = new Uint8Array(await crypto.subtle.deriveBits(
        {
            name: "PBKDF2",
            salt: salt,
            iterations: PASSWORD_HASH_ITERATIONS,
            hash: "SHA-256"
        },
        key,
        256
    ));

    const saltBase64 = btoa(String.fromCharCode(...salt));
    const hashBase64 = btoa(String.fromCharCode(...hash));
    return `pbkdf2-sha256$${PASSWORD_HASH_ITERATIONS}$${saltBase64}$${hashBase64}`;
}

function myFunction() {
    if (document.getElementById("user-username").value === "admin" && document.getElementById("user-password").value === "password") {
        alert("Logged in successfully!");
    } else {
        alert("Invalid username or password.");
    }
}

function togglePasswordVisibility() {
    var passwordField = document.getElementById("user-password");
    if (passwordField.type === "password") {
        passwordField.type = "text";
    } else {
        passwordField.type = "password";
    }
}

function validateForm() {
    var username = document.getElementById("user-username").value;
    var password = document.getElementById("user-password").value;
}

function validateSignUpForm() {
    var username = document.getElementById("signup-username").value;
    var password = document.getElementById("signup-password").value;
    var confirmPassword = document.getElementById("signup-confirm-password").value;
}


// if sign up or login successfull switch scene to main page
function switchscene() {
 if (loginsuccessful){
    window.location.href = "main.html";
 }
}

const loginForm = document.getElementById("login-form");
loginForm.addEventListener("submit", function(event) {
    event.preventDefault();
    myFunction();
});

