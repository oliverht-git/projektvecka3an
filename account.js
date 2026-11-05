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

function displayProfilePicture(profilePictureOverride) {
    const account = getActiveAccount();
    const profilePicture = typeof profilePictureOverride === "string"
        ? profilePictureOverride
        : account && typeof account.profilePicture === "string"
        ? account.profilePicture
        : "normalpfp.svg";

    document.querySelectorAll("#profile-picture-display").forEach(function(image) {
        image.src = profilePicture;
        if (profilePicture !== "normalpfp.svg") {
            image.onerror = function() {
                console.error("Kunde inte visa den sparade profilbilden.");
                image.onerror = null;
                image.src = "normalpfp.svg";
            };
        } else {
            image.onerror = null;
        }
    });
}

displayname();
displayProfilePicture();

const profilePictureInput = document.getElementById("profile-picture-input");
const changeProfilePictureButton = document.getElementById("change-profile-picture-button");

if (profilePictureInput && changeProfilePictureButton) {
    changeProfilePictureButton.addEventListener("click", function() {
        if (!getActiveAccount()) {
            alert("Du måste vara inloggad för att byta profilbild.");
            return;
        }

        profilePictureInput.click();
    });

    profilePictureInput.addEventListener("change", function() {
        const file = profilePictureInput.files && profilePictureInput.files[0];
        if (!file) {
            return;
        }

        if (!file.type.startsWith("image/")) {
            alert("Välj en bildfil.");
            profilePictureInput.value = "";
            return;
        }

        const reader = new FileReader();
        reader.onerror = function() {
            console.error("Kunde inte läsa profilbilden.", reader.error);
            alert("Bilden kunde inte läsas. Försök igen.");
            profilePictureInput.value = "";
        };
        reader.onload = function() {
            if (typeof reader.result !== "string") {
                console.error("Profilbilden lästes inte in som en data-URL.");
                alert("Bilden kunde inte läsas. Försök igen.");
                profilePictureInput.value = "";
                return;
            }

            const image = new Image();
            image.onerror = function() {
                console.error("Kunde inte visa den valda profilbilden.");
                alert("Bilden kunde inte öppnas. Försök med en annan bild.");
                profilePictureInput.value = "";
            };
            image.onload = async function() {
                if (!image.naturalWidth || !image.naturalHeight) {
                    console.error("Profilbilden saknar giltiga bildmått.");
                    alert("Bilden kunde inte behandlas. Försök med en annan bild.");
                    profilePictureInput.value = "";
                    return;
                }

                const maxDimension = 256;
                const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
                const canvas = document.createElement("canvas");
                canvas.width = Math.round(image.naturalWidth * scale);
                canvas.height = Math.round(image.naturalHeight * scale);

                const context = canvas.getContext("2d");
                if (!context) {
                    console.error("Kunde inte skapa en canvas för profilbilden.");
                    alert("Bilden kunde inte behandlas. Försök igen.");
                    profilePictureInput.value = "";
                    return;
                }

                try {
                    context.fillStyle = "#fff";
                    context.fillRect(0, 0, canvas.width, canvas.height);
                    context.drawImage(image, 0, 0, canvas.width, canvas.height);

                    const account = getActiveAccount();
                    if (!account) {
                        alert("Du måste vara inloggad för att byta profilbild.");
                        return;
                    }

                    account.profilePicture = canvas.toDataURL("image/jpeg", 0.8);
                    const response = await fetch("/api/users/profile", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            email: account.email,
                            profilePicture: account.profilePicture
                        })
                    });
                    if (!response.ok) {
                        throw new Error(`Servern svarade med status ${response.status}.`);
                    }

                    saveActiveAccount(account);
                    displayProfilePicture(account.profilePicture);
                } catch (error) {
                    console.error("Kunde inte spara profilbilden:", error);
                    alert("Profilbilden kunde inte delas. Kontrollera anslutningen och försök igen.");
                } finally {
                    profilePictureInput.value = "";
                }
            };
            image.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

const profileCard = document.getElementById("profile-card");
if (profileCard) {
    const profileCardPicture = document.getElementById("profile-card-picture");
    const profileCardName = document.getElementById("profile-card-name");
    const profileCardStatus = document.getElementById("profile-card-status");
    const profileCardFeedback = document.getElementById("profile-card-feedback");
    const yesButton = document.getElementById("yes");
    const noButton = document.getElementById("no");
    const reportProfileButton = document.getElementById("report-profile-button");
    let profiles = [];
    let currentProfileIndex = 0;
    let isSendingRequest = false;

    function showNextProfile() {
        if (currentProfileIndex >= profiles.length) {
            profileCard.hidden = true;
            if (reportProfileButton) {
                reportProfileButton.hidden = true;
            }
            profileCardStatus.textContent = profiles.length
                ? "Du har sett alla tillgängliga profiler."
                : "Det finns inga nya profiler att visa just nu.";
            yesButton.disabled = true;
            noButton.disabled = true;
            return;
        }

        const profile = profiles[currentProfileIndex];
        profileCard.hidden = false;
        if (reportProfileButton) {
            reportProfileButton.dataset.reportTargetId = profile.id;
            reportProfileButton.dataset.reportTargetName = profile.username;
            reportProfileButton.hidden = false;
        }
        profileCardName.textContent = profile.username;
        profileCardFeedback.textContent = "";
        profileCardPicture.onerror = function() {
            profileCardPicture.onerror = null;
            profileCardPicture.src = "normalpfp.svg";
        };
        profileCardPicture.src = profile.profilePicture || "normalpfp.svg";
        profileCardStatus.textContent = `${currentProfileIndex + 1} av ${profiles.length}`;
        yesButton.disabled = false;
        noButton.disabled = false;
    }

    async function loadProfiles() {
        const account = getActiveAccount();
        if (!account) {
            profileCard.hidden = true;
            profileCardStatus.textContent = "Logga in för att se profiler.";
            return;
        }

        try {
            const response = await fetch(`/api/users/profiles?exclude=${encodeURIComponent(account.email)}`);
            if (!response.ok) {
                throw new Error(`Servern svarade med status ${response.status}.`);
            }

            const result = await response.json();
            if (!Array.isArray(result.profiles)) {
                throw new Error("Servern returnerade en ogiltig profillista.");
            }

            const seenProfileIds = new Set();
            profiles = result.profiles.filter(profile => {
                if (
                    !profile
                    || typeof profile.id !== "string"
                    || typeof profile.username !== "string"
                    || !profile.username.trim()
                    || seenProfileIds.has(profile.id)
                ) {
                    return false;
                }

                seenProfileIds.add(profile.id);
                return true;
            });
            currentProfileIndex = 0;
            showNextProfile();
        } catch (error) {
            console.error("Kunde inte hämta profiler:", error);
            profileCard.hidden = true;
            profileCardStatus.textContent = "Profilerna kunde inte laddas. Försök igen senare.";
        }
    }

    yesButton.addEventListener("click", async function() {
        if (isSendingRequest || profiles.length === 0) {
            return;
        }

        const profile = profiles[currentProfileIndex];
        const account = getActiveAccount();
        isSendingRequest = true;
        yesButton.disabled = true;
        noButton.disabled = true;
        profileCardFeedback.textContent = "Skickar förfrågan...";

        try {
            const response = await fetch("/api/users/requests", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ fromEmail: account.email, toId: profile.id })
            });
            if (!response.ok) {
                throw new Error(`Servern svarade med status ${response.status}.`);
            }

            const result = await response.json();
            profileCardFeedback.textContent = result.status === "accepted"
                ? "Ni är redan anslutna."
                : "Förfrågan skickad.";
        } catch (error) {
            console.error("Kunde inte skicka förfrågan:", error);
            profileCardFeedback.textContent = "Förfrågan kunde inte skickas.";
            isSendingRequest = false;
            yesButton.disabled = false;
            noButton.disabled = false;
            return;
        }

        profiles.splice(currentProfileIndex, 1);
        if (currentProfileIndex >= profiles.length) {
            await loadProfiles();
        } else {
            showNextProfile();
        }
        isSendingRequest = false;
    });
    noButton.addEventListener("click", async function() {
        if (isSendingRequest || currentProfileIndex >= profiles.length) {
            return;
        }

        const account = getActiveAccount();
        const profile = profiles[currentProfileIndex];
        isSendingRequest = true;
        yesButton.disabled = true;
        noButton.disabled = true;
        profileCardFeedback.textContent = "Sparar...";

        try {
            const response = await fetch("/api/users/skip", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: account.email, targetId: profile.id })
            });
            if (!response.ok) {
                throw new Error(`Servern svarade med status ${response.status}.`);
            }
        } catch (error) {
            console.error("Kunde inte spara nekandet:", error);
            profileCardFeedback.textContent = "Valet kunde inte sparas. Försök igen.";
            isSendingRequest = false;
            yesButton.disabled = false;
            noButton.disabled = false;
            return;
        }

        currentProfileIndex += 1;
        if (currentProfileIndex >= profiles.length) {
            await loadProfiles();
        } else {
            showNextProfile();
        }
        isSendingRequest = false;
    });

    loadProfiles();
}

const incomingRequests = document.getElementById("incoming-requests");
if (incomingRequests) {
    const requestsStatus = document.getElementById("requests-status");
    const requestsList = document.getElementById("requests-list");

    async function loadIncomingRequests() {
        const account = getActiveAccount();
        if (!account) {
            requestsStatus.textContent = "Logga in för att se dina förfrågningar.";
            return;
        }

        try {
            const response = await fetch(`/api/users/requests?email=${encodeURIComponent(account.email)}`);
            if (!response.ok) {
                throw new Error(`Servern svarade med status ${response.status}.`);
            }

            const result = await response.json();
            if (!Array.isArray(result.requests)) {
                throw new Error("Servern returnerade en ogiltig lista med förfrågningar.");
            }

            requestsList.replaceChildren();
            if (result.requests.length === 0) {
                requestsStatus.textContent = "Du har inga nya förfrågningar.";
                return;
            }

            requestsStatus.textContent = "";
            result.requests.forEach(function(request) {
                const card = document.createElement("article");
                card.className = "request-card";

                const image = document.createElement("img");
                image.src = request.profilePicture || "normalpfp.svg";
                image.alt = "";
                image.onerror = function() {
                    image.onerror = null;
                    image.src = "normalpfp.svg";
                };

                const name = document.createElement("p");
                name.className = "request-card-name";
                name.textContent = request.username;

                const acceptButton = document.createElement("button");
                acceptButton.type = "button";
                acceptButton.textContent = "Acceptera";
                acceptButton.addEventListener("click", async function() {
                    acceptButton.disabled = true;
                    acceptButton.textContent = "Accepterar...";
                    try {
                        const acceptResponse = await fetch("/api/users/requests/accept", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ email: account.email, requestId: request.id })
                        });
                        if (!acceptResponse.ok) {
                            throw new Error(`Servern svarade med status ${acceptResponse.status}.`);
                        }
                        await loadIncomingRequests();
                    } catch (error) {
                        console.error("Kunde inte acceptera förfrågan:", error);
                        acceptButton.disabled = false;
                        acceptButton.textContent = "Acceptera";
                        requestsStatus.textContent = "Förfrågan kunde inte accepteras. Försök igen.";
                    }
                });

                card.append(image, name, acceptButton);
                requestsList.append(card);
            });
        } catch (error) {
            console.error("Kunde inte hämta förfrågningar:", error);
            requestsStatus.textContent = "Förfrågningarna kunde inte laddas. Försök igen senare.";
        }
    }

    loadIncomingRequests();
}

const friendsDialog = document.getElementById("friends-dialog");
const openFriendsButton = document.getElementById("open-friends-button");
const profileFriendsToggle = document.getElementById("toggle-profile-friends");
const profileFriendsList = document.getElementById("profile-friends-list");
const friendsDialogList = document.getElementById("friends-dialog-list");
const profileFriendsItems = document.getElementById("profile-friends-items");
const friendsDialogStatus = document.getElementById("friends-dialog-status");
const profileFriendsStatus = document.getElementById("profile-friends-status");
const removeFriendDialog = document.getElementById("remove-friend-dialog");

if (friendsDialog || profileFriendsToggle) {
    let friends = [];
    let friendToRemove = null;
    const confirmRemoveFriendButton = document.getElementById("confirm-remove-friend");
    const cancelRemoveFriendButton = document.getElementById("cancel-remove-friend");
    const removeFriendMessage = document.getElementById("remove-friend-message");

    function renderFriends() {
        [friendsDialogList, profileFriendsItems].forEach(function(container) {
            if (!container) {
                return;
            }

            container.replaceChildren();
            friends.forEach(function(friend) {
                const row = document.createElement("article");
                row.className = "friend-row";

                const image = document.createElement("img");
                image.src = friend.profilePicture || "normalpfp.svg";
                image.alt = "";
                image.onerror = function() {
                    image.onerror = null;
                    image.src = "normalpfp.svg";
                };

                const name = document.createElement("p");
                name.className = "friend-row-name";
                name.textContent = friend.username;

                const removeButton = document.createElement("button");
                removeButton.className = "friend-remove-button";
                removeButton.type = "button";
                removeButton.textContent = "×";
                removeButton.setAttribute("aria-label", `Ta bort ${friend.username}`);
                removeButton.addEventListener("click", function() {
                    friendToRemove = friend;
                    removeFriendMessage.textContent =
                        `Är du säker på att du vill ta bort ${friend.username}? Personen tas även bort från din konversationslista.`;
                    removeFriendDialog.showModal();
                });

                row.append(image, name, removeButton);
                container.append(row);
            });
        });

        const emptyMessage = friends.length ? "" : "Du har inga vänner ännu.";
        if (friendsDialogStatus) {
            friendsDialogStatus.textContent = emptyMessage;
        }
        if (profileFriendsStatus) {
            profileFriendsStatus.textContent = emptyMessage;
        }
    }

    async function loadFriends() {
        const account = getActiveAccount();
        if (!account) {
            friends = [];
            renderFriends();
            if (friendsDialogStatus) {
                friendsDialogStatus.textContent = "Logga in för att se din vänlista.";
            }
            if (profileFriendsStatus) {
                profileFriendsStatus.textContent = "Logga in för att se din vänlista.";
            }
            return;
        }

        if (friendsDialogStatus) {
            friendsDialogStatus.textContent = "Laddar vänlistan...";
        }
        if (profileFriendsStatus && profileFriendsList && !profileFriendsList.hidden) {
            profileFriendsStatus.textContent = "Laddar vänlistan...";
        }

        try {
            const response = await fetch(`/api/users/friends?email=${encodeURIComponent(account.email)}`);
            if (!response.ok) {
                throw new Error(`Servern svarade med status ${response.status}.`);
            }

            const result = await response.json();
            if (!Array.isArray(result.friends)) {
                throw new Error("Servern returnerade en ogiltig vänlista.");
            }

            const seenIds = new Set();
            friends = result.friends.filter(function(friend) {
                if (
                    !friend
                    || typeof friend.id !== "string"
                    || typeof friend.username !== "string"
                    || seenIds.has(friend.id)
                ) {
                    return false;
                }
                seenIds.add(friend.id);
                return true;
            });
            renderFriends();
        } catch (error) {
            console.error("Kunde inte hämta vänlistan:", error);
            if (friendsDialogStatus) {
                friendsDialogStatus.textContent = "Vänlistan kunde inte laddas. Försök igen.";
            }
            if (profileFriendsStatus && profileFriendsList && !profileFriendsList.hidden) {
                profileFriendsStatus.textContent = "Vänlistan kunde inte laddas. Försök igen.";
            }
        }
    }

    if (openFriendsButton && friendsDialog) {
        openFriendsButton.addEventListener("click", function() {
            friendsDialog.showModal();
            loadFriends();
        });
    }

    document.querySelectorAll("[data-close-dialog='friends-dialog']").forEach(function(button) {
        button.addEventListener("click", function() {
            friendsDialog.close();
        });
    });

    if (profileFriendsToggle && profileFriendsList) {
        profileFriendsToggle.addEventListener("click", function() {
            const isOpening = profileFriendsList.hidden;
            profileFriendsList.hidden = !isOpening;
            profileFriendsToggle.setAttribute("aria-expanded", String(isOpening));
            profileFriendsToggle.textContent = isOpening ? "Dölj vänlista" : "Visa vänlista";
            if (isOpening) {
                loadFriends();
            }
        });
    }

    cancelRemoveFriendButton.addEventListener("click", function() {
        removeFriendDialog.close();
        friendToRemove = null;
    });

    removeFriendDialog.addEventListener("click", function(event) {
        if (event.target === removeFriendDialog) {
            removeFriendDialog.close();
            friendToRemove = null;
        }
    });

    confirmRemoveFriendButton.addEventListener("click", async function() {
        const account = getActiveAccount();
        if (!account || !friendToRemove) {
            return;
        }

        confirmRemoveFriendButton.disabled = true;
        confirmRemoveFriendButton.textContent = "Tar bort...";
        try {
            const response = await fetch("/api/users/friends/remove", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: account.email, friendId: friendToRemove.id })
            });
            if (!response.ok) {
                throw new Error(`Servern svarade med status ${response.status}.`);
            }

            removeFriendDialog.close();
            friendToRemove = null;
            await loadFriends();
        } catch (error) {
            console.error("Kunde inte ta bort vännen:", error);
            removeFriendMessage.textContent = "Vännen kunde inte tas bort. Försök igen.";
        } finally {
            confirmRemoveFriendButton.disabled = false;
            confirmRemoveFriendButton.textContent = "Ta bort";
        }
    });
}

window.addEventListener("storage", function(event) {
    if (event.key === ACTIVE_ACCOUNT_KEY || (event.key && event.key.startsWith(ACCOUNT_STORAGE_PREFIX))) {
        displayname();
        displayProfilePicture();
    }
});
