const reportDialog = document.getElementById("report-dialog");
const reportForm = document.getElementById("report-form");
const reportSubject = document.getElementById("report-subject");
const reportStatus = document.getElementById("report-status");
const reportReason = document.getElementById("report-reason");
const reportDetails = document.getElementById("report-details");
const submitReportButton = document.getElementById("submit-report-button");
const cancelReportButton = document.getElementById("cancel-report-button");

let activeReport = null;
let activeReportButton = null;

document.addEventListener("click", function(event) {
    const button = event.target.closest("[data-report-type]");
    if (!button || !reportDialog) {
        return;
    }

    activeReport = {
        type: button.dataset.reportType,
        targetId: button.dataset.reportTargetId,
        targetName: button.dataset.reportTargetName || "Användare"
    };
    activeReportButton = button;
    reportForm.reset();
    reportStatus.textContent = "";
    reportSubject.textContent = activeReport.type === "profile"
        ? `Anmäl profilbilden för ${activeReport.targetName}.`
        : `Anmäl ett meddelande från ${activeReport.targetName}. Meddelandeloggen bifogas för granskning.`;
    cancelReportButton.textContent = "Avbryt";
    submitReportButton.disabled = false;
    reportDialog.showModal();
});

cancelReportButton.addEventListener("click", function() {
    reportDialog.close();
});

reportForm.addEventListener("submit", async function(event) {
    event.preventDefault();
    const account = getActiveAccount();
    if (!account) {
        reportStatus.textContent = "Logga in för att skicka en anmälan.";
        return;
    }
    if (!activeReport || !activeReport.targetId) {
        reportStatus.textContent = "Innehållet kunde inte identifieras. Försök igen.";
        return;
    }

    submitReportButton.disabled = true;
    reportStatus.textContent = "Skickar anmälan...";
    try {
        const response = await fetch("/api/reports", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                reporterEmail: account.email,
                targetType: activeReport.type,
                targetId: activeReport.targetId,
                reason: reportReason.value,
                details: reportDetails.value
            })
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || `Servern svarade med status ${response.status}.`);
        }

        reportStatus.textContent = "Anmälan har skickats till administratören.";
        submitReportButton.textContent = "Skickat";
        if (activeReportButton) {
            activeReportButton.disabled = true;
            activeReportButton.textContent = "Anmäld";
        }
        cancelReportButton.textContent = "Stäng";
    } catch (error) {
        console.error("Kunde inte skicka anmälan:", error);
        reportStatus.textContent = error.message === "This item has already been reported."
            ? "Du har redan anmält det här innehållet."
            : "Anmälan kunde inte skickas. Försök igen.";
        submitReportButton.disabled = false;
    }
});
