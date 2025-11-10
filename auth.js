/**
 * Server-side authentication helpers for MobiShare
 * This module provides Firebase authentication functions for the Express server
 */

const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');
const nodeFetch = require('node-fetch');

/**
 * Extract Firebase API key from environment variables
 * @returns {string|null} - Firebase API key or null if not found
 */
const getFirebaseApiKey = () => {
    const apiKey = process.env.FIREBASE_API_KEY;
    
    if (apiKey) {
        return apiKey;
    } else {
        console.error('FIREBASE_API_KEY not found in environment variables');
        return null;
    }
};

/**
 * Sign in user with email and password
 * @param {string} email - User email
 * @param {string} password - User password
 * @returns {Promise<Object>} - Object containing user data and token or error
 */
const signIn = async (email, password) => {
    try {
        const apiKey = getFirebaseApiKey();
        
        if (!apiKey) {
            throw new Error('Could not get Firebase API key from config');
        }
        
        const signInResponse = await nodeFetch(
            `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email,
                    password,
                    returnSecureToken: true
                })
            }
        );
        
        // Handle authentication errors
        if (!signInResponse.ok) {
            const errorData = await signInResponse.json();
            console.error('Error signing in:', errorData);
            
            // Map Firebase error codes to user-friendly messages
            let errorMessage = 'Errore durante il login. Riprova più tardi.';
            let errorCode = 'unknown';
            
            if (errorData.error) {
                errorCode = errorData.error.message;
                switch (errorData.error.message) {
                    case 'EMAIL_NOT_FOUND':
                    case 'INVALID_PASSWORD':
                        errorMessage = 'Email o password non validi';
                        break;
                    case 'USER_DISABLED':
                        errorMessage = 'Questo account è stato disabilitato';
                        break;
                    case 'TOO_MANY_ATTEMPTS_TRY_LATER':
                        errorMessage = 'Troppi tentativi falliti. Riprova più tardi';
                        break;
                }
            }
            
            return { success: false, error: { message: errorMessage, code: errorCode } };
        }
        
        // Get token from successful response
        const signInData = await signInResponse.json();
        
        return { 
            success: true, 
            user: {
                uid: signInData.localId,
                email: signInData.email,
                displayName: signInData.displayName,
                idToken: signInData.idToken
            }
        };
    } catch (error) {
        console.error('Login error:', error);
        return { success: false, error: { message: error.message, code: 'login_error' } };
    }
};

/**
 * Register a new user with email and password
 * @param {string} email - User email
 * @param {string} password - User password
 * @param {string} name - User display name
 * @returns {Promise<Object>} - Object containing user data or error
 */
const signUp = async (email, password, name) => {
    try {
        // Create user with Firebase Admin SDK
        const userRecord = await admin.auth().createUser({
            email,
            password,
            displayName: name,
            emailVerified: false
        });
        
        console.log('User created successfully:', userRecord.uid);
        
        return { 
            success: true, 
            user: {
                uid: userRecord.uid,
                email: userRecord.email,
                displayName: userRecord.displayName
            }
        };
    } catch (error) {
        console.error('Registration error:', error);
        
        let errorMessage = 'Errore durante la registrazione. Riprova più tardi.';
        let errorField = null;
        
        if (error.code === 'auth/email-already-exists') {
            errorMessage = 'Email già in uso';
            errorField = 'email';
        } else if (error.code === 'auth/invalid-email') {
            errorMessage = 'Email non valida';
            errorField = 'email';
        } else if (error.code === 'auth/weak-password') {
            errorMessage = 'Password troppo debole';
            errorField = 'password';
        }
        
        return { 
            success: false, 
            error: { 
                message: errorMessage, 
                code: error.code || 'registration_error',
                field: errorField
            }
        };
    }
};

/**
 * Create a session cookie from an ID token
 * @param {string} idToken - Firebase ID token
 * @param {number} expiresIn - Cookie expiration time in milliseconds
 * @returns {Promise<Object>} - Object containing session cookie or error
 */
const createSessionCookie = async (idToken, expiresIn) => {
    try {
        const sessionCookie = await admin.auth().createSessionCookie(idToken, { expiresIn });
        
        const cookieOptions = {
            maxAge: expiresIn,
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            path: '/',
            sameSite: 'lax'
        };
        
        return {
            success: true,
            sessionCookie, cookieOptions
        };
    } catch (error) {
        console.error('Session cookie creation error:', error);
        return {
            success: false,
            error: { 
                message: 'Errore durante la creazione della sessione', 
                code: 'session_creation_error' 
            }
        };
    }
};

/**
 * Verify a session cookie and get user claims
 * @param {string} sessionCookie - Firebase session cookie
 * @returns {Promise<Object>} - Object containing user claims or error
 */
const verifySessionCookie = async (sessionCookie) => {
    try {
        const decodedClaims = await admin.auth().verifySessionCookie(sessionCookie);
        const userRecord = await admin.auth().getUser(decodedClaims.uid);
        
        return { 
            success: true, 
            user: {
                ...decodedClaims,
                displayName: userRecord.displayName,
                email: userRecord.email
            }
        };
    } catch (error) {
        console.error('Session verification error:', error);
        return { 
            success: false, 
            error: { 
                message: 'Sessione non valida', 
                code: 'invalid_session' 
            }
        };
    }
};

module.exports = {
    getFirebaseApiKey,
    loginUser: signIn,
    registerUser: signUp,
    createSessionCookie,
    verifySessionCookie
};
