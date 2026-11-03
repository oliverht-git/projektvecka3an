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

// if sign up or login successfull switch scene to main page
function switchscene() {
    
}