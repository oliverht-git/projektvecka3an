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


