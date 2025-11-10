/**
 * Firebase Client Configuration
 *
 * This file initializes the Firebase Web SDK with your Firebase project configuration.
 *
 * To get your Firebase configuration:
 * 1. Go to the Firebase Console: https://console.firebase.google.com/
 * 2. Select your project
 * 3. Click on the gear icon (⚙️) next to "Project Overview" to access Project settings
 * 4. Scroll down to the "Your apps" section
 * 5. If you don't have a web app already, click the web icon </> to create one
 * 6. Copy the firebaseConfig object
 * 7. Replace the placeholder values below with your actual configuration
 */

// Firebase Configuration and Helpers

// Import Firebase SDK modules
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";

// Auth related imports
import { 
    getAuth, 
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    onAuthStateChanged,
    signOut,
    browserLocalPersistence,
    setPersistence
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

// Firestore related imports
import { 
    getFirestore, 
    collection, 
    doc, 
    getDoc, 
    setDoc, 
    updateDoc,
    getDocs,
    query,
    where,
    orderBy,
    limit,
    startAfter,
    serverTimestamp,
    Timestamp,
    deleteDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Storage related imports
import { 
    getStorage, 
    ref, 
    uploadBytesResumable, 
    getDownloadURL,
    uploadBytes, 
    listAll, 
    deleteObject
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

// Get Firebase configuration from the window global variable set by the server
if (!window.firebaseConfig || !window.firebaseConfig.apiKey) {
    console.error("Firebase configuration is missing or incomplete. Authentication and other Firebase features will not work correctly.");
    console.log("Current config:", window.firebaseConfig);
}

// Use configuration from server with validation
const firebaseConfig = {
    apiKey: window.firebaseConfig?.apiKey || "",
    authDomain: window.firebaseConfig?.authDomain || "",
    projectId: window.firebaseConfig?.projectId || "",
    storageBucket: window.firebaseConfig?.storageBucket || "",
    messagingSenderId: window.firebaseConfig?.messagingSenderId || "",
    appId: window.firebaseConfig?.appId || "",
    measurementId: window.firebaseConfig?.measurementId || ""
};

// Validate required config properties
const requiredProps = ['apiKey', 'authDomain', 'projectId'];
const missingProps = requiredProps.filter(prop => !firebaseConfig[prop]);

if (missingProps.length > 0) {
    console.error(`Missing required Firebase configuration: ${missingProps.join(', ')}`);
}

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize services
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

// Set persistence to local (survives browser restarts)
setPersistence(auth, browserLocalPersistence)
    .then(() => console.log("Auth persistence set to local"))
    .catch(error => console.error("Error setting auth persistence:", error));

/**
 * Firestore helper functions
 */

// Get document by ID
async function getDocument(collectionName, docId) {
	try {
		const docRef = doc(db, collectionName, docId);
		const docSnap = await getDoc(docRef);

		if (docSnap.exists()) {
			return { data: { id: docSnap.id, ...docSnap.data() }, error: null };
		} else {
			return { data: null, error: "Document does not exist" };
		}
	} catch (error) {
		console.error("Error getting document:", error);
		return { data: null, error: error.message };
	}
}

// Get all documents from a collection
async function getCollection(collectionName) {
	try {
		const querySnapshot = await getDocs(collection(db, collectionName));
		const documents = [];

		querySnapshot.forEach((doc) => {
			documents.push({ id: doc.id, ...doc.data() });
		});

		return { data: documents, error: null };
	} catch (error) {
		console.error("Error getting collection:", error);
		return { data: null, error: error.message };
	}
}

// Create or update a document
async function saveDocument(collectionName, docId, data) {
	try {
		const docRef = doc(db, collectionName, docId);
		await setDoc(docRef, data, { merge: true });
		return { success: true, error: null };
	} catch (error) {
		console.error("Error saving document:", error);
		return { success: false, error: error.message };
	}
}

// Delete a document
async function deleteDocument(collectionName, docId) {
	try {
		const docRef = doc(db, collectionName, docId);
		await deleteDoc(docRef);
		return { success: true, error: null };
	} catch (error) {
		console.error("Error deleting document:", error);
		return { success: false, error: error.message };
	}
}

/**
 * Storage helper functions
 */

// Upload file to storage
async function uploadFile(folderPath, file) {
	try {
		const filePath = `${folderPath}/${file.name}`;
		const storageRef = ref(storage, filePath);
		const snapshot = await uploadBytes(storageRef, file);
		const downloadURL = await getDownloadURL(snapshot.ref);

		return { url: downloadURL, path: filePath, error: null };
	} catch (error) {
		console.error("Error uploading file:", error);
		return { url: null, path: null, error: error.message };
	}
}

// Get download URL for a file
async function getFileURL(filePath) {
	try {
		const storageRef = ref(storage, filePath);
		const url = await getDownloadURL(storageRef);
		return { url, error: null };
	} catch (error) {
		console.error("Error getting download URL:", error);
		return { url: null, error: error.message };
	}
}

// List all files in a folder
async function listFiles(folderPath) {
	try {
		const folderRef = ref(storage, folderPath);
		const fileList = await listAll(folderRef);

		const files = await Promise.all(fileList.items.map(async (itemRef) => {
			const url = await getDownloadURL(itemRef);
			return {
				name: itemRef.name,
				fullPath: itemRef.fullPath,
				url: url
			};
		}));

		return { files, error: null };
	} catch (error) {
		console.error("Error listing files:", error);
		return { files: null, error: error.message };
	}
}

// Delete a file from storage
async function deleteFile(filePath) {
	try {
		const storageRef = ref(storage, filePath);
		await deleteObject(storageRef);
		return { success: true, error: null };
	} catch (error) {
		console.error("Error deleting file:", error);
		return { success: false, error: error.message };
	}
}

// Error handler function for consistent error formatting
function handleError(operation, error) {
    const errorMessage = error?.message || 'Unknown error occurred';
    const errorCode = error?.code || 'unknown';
    
    console.error(`Error during ${operation}:`, error);
    
    return {
        success: false,
        error: {
            code: errorCode,
            message: errorMessage
        }
    };
}

export {
	// Core Firebase services
	app,
	auth,
	db,
	storage,

	// Firestore helper functions
	getDocument,
	getCollection,
	saveDocument,
	deleteDocument,

	// Storage helper functions
	uploadFile,
	getFileURL,
	listFiles,
	deleteFile,

	// Config for reference
	firebaseConfig
};
