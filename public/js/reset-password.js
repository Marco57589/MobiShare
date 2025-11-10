// Import Firebase auth functionality
import { auth } from './firebase-config.js';
import { sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

document.addEventListener('DOMContentLoaded', () => {
    const resetForm = document.getElementById('reset-form');
    const resetEmailInput = document.getElementById('email');
    const alertSuccess = document.getElementById('reset-success');
    const alertError = document.getElementById('reset-error');

    // Hide initial alerts
    if (alertSuccess) alertSuccess.classList.add('d-none');
    if (alertError) alertError.classList.add('d-none');

    resetForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        // Clear previous alerts
        if (alertSuccess) alertSuccess.classList.add('d-none');
        if (alertError) alertError.classList.add('d-none');

        const email = resetEmailInput.value.trim();
        if (!email) {
            showError("Inserisci l'indirizzo email");
            return;
        }

        try {
            // Send password reset email using Firebase
            await sendPasswordResetEmail(auth, email);
            
            // Show success message
            showSuccess('Email inviata! Controlla la tua casella di posta.');
            resetForm.reset();
        } catch (error) {
            console.error('Error sending password reset email:', error);
            
            // Handle different Firebase Auth errors
            let errorMessage = '';
            switch (error.code) {
                case 'auth/invalid-email':
                    errorMessage = 'Indirizzo email non valido.';
                    break;
                case 'auth/user-not-found':
                    showSuccess('Se questa email è registrata, riceverai un link per reimpostare la password.');
                    resetForm.reset();
                    return;
                default:
                    errorMessage = 'Si è verificato un errore. Riprova più tardi.';
            }
            
            showError(errorMessage);
        }
    });

    function showError(message) {
        if (alertError) {
            alertError.textContent = message;
            alertError.classList.remove('d-none');
        }
    }

    function showSuccess(message) {
        if (alertSuccess) {
            alertSuccess.textContent = message;
            alertSuccess.classList.remove('d-none');
        }
    }
});

