const express = require('express');
const path = require('path');
const admin = require('firebase-admin');
const cookieParser = require('cookie-parser');
const dotenv = require('dotenv');
const session = require('express-session');
const mqtt = require('mqtt');
const axios = require('axios')
const FormData = require('form-data');
const fileUpload = require('express-fileupload');

const {
	loginUser,
	registerUser,
	createSessionCookie,
	verifySessionCookie,
} = require('./auth');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Load service account for Firebase Admin SDK
const serviceAccount = require('./serviceAccountKey.json');

// Configure Firebase Admin SDK
const firebaseConfig = {
	credential: admin.credential.cert(serviceAccount),
	databaseURL: process.env.FIREBASE_DATABASE_URL
};

console.log('Firebase Admin SDK configured with serviceAccountKey.json');

// Initialize Firebase Admin
try {
	admin.initializeApp(firebaseConfig);
	console.log('Firebase Admin SDK initialized successfully');
} catch (error) {
	console.error('Error initializing Firebase Admin SDK:', error);
	process.exit(1);
}

// Configurazioni MQTT
const MQTT_HOST = process.env.MQTT_HOST || 'localhost';
const MQTT_PORT = process.env.MQTT_PORT || 1883;

let mqttClient;

async function connectMqttClient(userId, ruolo) {
	try {
		if (!userId) {
			throw new Error('User ID non fornito per la connessione MQTT');
		}
		
		if (ruolo !== 'gestore' && mqttClient && mqttClient.connected) {
			mqttClient.end();
			return;
		}
		
		const customToken = await admin.auth().createCustomToken(userId);
		const { initializeApp } = require('firebase/app');
		const { getAuth, signInWithCustomToken } = require('firebase/auth');
		
		const firebaseClientApp = initializeApp({
			apiKey: process.env.FIREBASE_API_KEY,
			authDomain: process.env.FIREBASE_AUTH_DOMAIN,
			projectId: process.env.FIREBASE_PROJECT_ID,
		});
		
		const auth = getAuth(firebaseClientApp);
		const userCredential = await signInWithCustomToken(auth, customToken);
		const idToken = await userCredential.user.getIdToken();
		
		mqttClient = mqtt.connect(`mqtt://${MQTT_HOST}:${MQTT_PORT}`, {
			username: userId,
			password: idToken,
			reconnectPeriod: 0 // Disabilita riconnessione automatica
		});
		
		mqttClient.on('connect', () => {
			console.log(`Utente ${userId} (${ruolo}) connesso al broker MQTT`);
			
			if (ruolo === 'gestore') {
				mqttClient.subscribe('mobishare/mezzi/comando', (err) => {
					if (err) {
						console.error('Errore nella sottoscrizione al topic comandi:', err);
					}
				});
			}
			
			mqttClient.subscribe(['mobishare/mezzi/stato', 'mobishare/mezzi/notifiche'], (err) => {
				if (err) {
					console.error('Errore nella sottoscrizione ai topic generali:', err);
				}
			});
		});
		
		mqttClient.on('message', (topic, message) => {
			console.log(`Messaggio ricevuto su ${topic} da ${userId}: ${message.toString()}`);
		});
		
		mqttClient.on('error', (err) => {
			console.error(`Errore MQTT per ${userId}:`, err.message);
		});
		
		mqttClient.on('close', () => {
			console.log(`Connessione MQTT chiusa per ${userId}`);
		});
		
	} catch (error) {
		console.error(`Errore connessione MQTT per ${userId}:`, error.message);
	}
}

module.exports.mqttClient = mqttClient;

//----------------------------------------@----------------------------------------------------------

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(fileUpload());
app.use(session({
	secret: process.env.SESSION_SECRET || 'mobishare-secret',
	resave: false,
	saveUninitialized: false,
	cookie: {
		secure: process.env.NODE_ENV === 'production',
		maxAge: 60 * 60 * 24 * 5 * 1000 // 5 days
	}
}));

app.use((req, res, next) => {
	// Firebase config
	res.locals.firebaseConfig = {
		apiKey: process.env.FIREBASE_API_KEY,
		authDomain: process.env.FIREBASE_AUTH_DOMAIN,
		projectId: process.env.FIREBASE_PROJECT_ID,
		storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
		messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
		appId: process.env.FIREBASE_APP_ID,
		measurementId: process.env.FIREBASE_MEASUREMENT_ID
	};
	
	// Flash messages
	res.locals.success = req.session.success;
	res.locals.error = req.session.error;
	res.locals.errors = req.session.errors;
	res.locals.formData = req.session.formData;
	
	// Clear flash messages
	['success', 'error', 'errors', 'formData'].forEach(key => delete req.session[key]);
	
	next();
});

// Middleware per verificare l'autenticazione
const checkAuth = async (req, res, next) => {
	const sessionCookie = req.cookies.session || '';
	
	if (sessionCookie) {
		try {
			const { success, user, error } = await verifySessionCookie(sessionCookie);
			
			if (success) {
				const userDoc = await admin.firestore().collection('users').doc(user.uid).get();
				
				if (userDoc.exists) {
					req.user = {
						uid: user.uid,
						email: user.email,
						ruolo: userDoc.data().ruolo,
						...userDoc.data()
					};
				} else {
					req.user = user;
				}
			} else {
				console.error('Session verification error:', error);
				req.user = null;
			}
		} catch (error) {
			console.error('Session verification exception:', error);
			req.user = null;
		}
	} else {
		req.user = null;
	}
	
	next();
};

const requireGestore = (req, res, next) => {
	if (!req.user) {
		req.session.error = 'Accesso non autorizzato. Effettua il login.';
		return res.redirect('/login');
	}
	
	if (req.user.ruolo !== 'gestore') {
		req.session.error = 'Accesso riservato ai gestori del sistema.';
		return res.redirect('/');
	}
	
	next();
};

app.use(checkAuth);

//funzione per la geolicalizzazione degli indirizzi dei parcheggi
async function getCoordinates(via) {
	try {
		const response = await axios.get('https://nominatim.openstreetmap.org/search', {
			params: {
				q: `${via}, Vercelli, Italia`,
				format: 'json',
				limit: 1
			}
		});
		
		if (response.data.length > 0) {
			const { lat, lon } = response.data[0];
			return { lat: parseFloat(lat), lon: parseFloat(lon) };
		} else {
			console.error(`Indirizzo non trovato: ${via}`);
			return null;
		}
	} catch (error) {
		console.error('Errore durante il geocoding:', error);
		return null;
	}
}

const db = admin.firestore();
const firestoreHelpers = {
	getCollection: async (collectionName) => {
		const snapshot = await db.collection(collectionName).get();
		return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
	},
	
	getDoc: async (collectionName, docId) => {
		const doc = await db.collection(collectionName).doc(docId).get();
		return doc.exists ? { id: doc.id, ...doc.data() } : null;
	},
	
	getWhere: async (collectionName, field, operator, value) => {
		const snapshot = await db.collection(collectionName).where(field, operator, value).get();
		return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
	},
	getLastDoc: async (collectionName, orderByField = 'id') => {
		const snapshot = await db.collection(collectionName)
			.orderBy(orderByField, 'desc')
			.limit(1)
			.get();
		return snapshot.empty ? null : { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
	},
	updateByNumericId: async (collectionName, numericIdField, numericIdValue, updateData) => {
		const snapshot = await db.collection(collectionName)
			.where(numericIdField, '==', numericIdValue)
			.get();
		
		if (snapshot.empty) {
			throw new Error(`Documento non trovato in ${collectionName} con ${numericIdField} = ${numericIdValue}`);
		}
		
		const doc = snapshot.docs[0];
		await doc.ref.update(updateData);
		
		return { id: doc.id, ...updateData };
	},
	getDocIdByNumericId: async (collectionName, numericIdField, numericIdValue) => {
		const snapshot = await db.collection(collectionName)
			.where(numericIdField, '==', numericIdValue)
			.limit(1)
			.get();
		
		if (snapshot.empty) {
			return null;
		}
		return snapshot.docs[0].id;
	}
};

app.use((req, res, next) => {
	res.locals.user = req.user;
	next();
});

app.get('/', async (req, res) => {
	if (req.user == null) {
		res.redirect('login');
	} else {
		try {
			const [mezzi, parcheggiSnapshot, utentiSospesiSnapshot, tariffeSnapshot, danniSnap] = await Promise.all([
				firestoreHelpers.getCollection('mezzi'),
				firestoreHelpers.getCollection('parcheggi'),
				firestoreHelpers.getWhere('users', 'stato_profilo', '==', 'sospeso'),
				firestoreHelpers.getCollection('tariffe'),
				firestoreHelpers.getCollection('danni')
			]);
			
			const parcheggi = parcheggiSnapshot.map(parcheggio => {
				const mezziDisponibili = mezzi.filter(m => m.id_parcheggio === parcheggio.id && m.stato === 'Disponibile').length;
				return {
					...parcheggio,
					mezziDisponibili
				};
			});
			
			const numeroUtentiSospesi = utentiSospesiSnapshot.length;
			const tariffe = tariffeSnapshot;
			
			const mezziBatteriaScarica = danniSnap.filter(d => d.tipoDanno && d.tipoDanno.includes('Batteria scarica'));
			const numeroMezziBatteriaScarica = new Set(mezziBatteriaScarica.map(d => d.mezzoId)).size;
			const mezziInManutenzione = new Set(danniSnap.map(d => d.mezzoId));
			const numeroMezziInManutenzione = mezziInManutenzione.size - numeroMezziBatteriaScarica;
			
			res.render('index', {
				title: 'MobiShare - Home',
				currentPage: 'home',
				numeroUtentiSospesi,
				parcheggi,
				tariffe,
				numeroMezziInManutenzione,
				numeroMezziBatteriaScarica,
				stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY
			});
		} catch (error) {
			console.error('Errore nel recupero dei dati:', error);
			req.session.error = 'Errore nel caricamento della pagina';
			return res.redirect('/');
		}
	}
});
// Password reset route - only handles the page rendering, actual reset is client-side
app.get('/reset-password', (req, res) => {
	res.render('reset-password', {
		title: 'MobiShare - Reimposta Password',
		currentPage: ''
	});
});

app.get('/gestione-credito', async (req, res) => {
	if (!req.user) return res.redirect('/login');
	
	try {
		const ricariche = await firestoreHelpers.getWhere('ricariche', 'userId', '==', req.user.uid);
		const listaRicariche = ricariche
			.sort((a, b) => b.data.toDate() - a.data.toDate())
			.map(doc => ({
				data: doc.data.toDate().toLocaleString('it-IT'),
				importo: doc.importo,
				metodo: doc.metodo || 'Ricarica'
			}));
		
		res.render('gestione-credito', {
			title: 'Gestione Credito',
			currentPage: null,
			ricariche: listaRicariche,
			need: req.query.need || null,
			returnTo: req.query.return || null,
			stripeAmount: null,
			stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY
		});
	} catch (error) {
		console.error('Errore nel recupero del saldo utente:', error);
		res.status(500).send('Errore interno del server');
	}
});

app.post('/gestione-credito', async (req, res) => {
	if (!req.user) return res.redirect('/login');
	
	try {
		const totaleRicarica = Number(req.body.valoredacaricare);
		const returnTo = req.query.return || req.body.return || null;
		
		if (totaleRicarica <= 0) {
			req.session.error = 'L\'importo deve essere maggiore di 0';
			return res.redirect(`/gestione-credito${returnTo ? ('?return=' + encodeURIComponent(returnTo)) : ''}`);
		}
		
		if (totaleRicarica > 1000) {
			req.session.error = 'L\'importo massimo per una ricarica è di €1000';
			return res.redirect(`/gestione-credito${returnTo ? ('?return=' + encodeURIComponent(returnTo)) : ''}`);
		}
		
		let dbRicariche = await admin.firestore().collection('ricariche')
			.where('userId','==', req.user.uid)
			.orderBy('data', 'desc')
			.get();
		
		const listaRicariche = dbRicariche.docs.map(doc => ({
			data: doc.data().data.toDate().toLocaleString('it-IT'),
			importo: doc.data().importo,
			metodo: doc.data().metodo || 'Ricarica'
		}));
		
		res.render('gestione-credito', {
			title: 'Gestione Credito',
			currentPage: null,
			ricariche: listaRicariche,
			need: req.query.need || null,
			returnTo: returnTo,
			stripeAmount: totaleRicarica,
			stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY
		});
		
	} catch (error) {
		console.error('Errore durante la ricarica:', error);
		req.session.error = 'Errore durante la ricarica. Riprova più tardi.';
		res.redirect('/gestione-credito');
	}
});

// endpoint pagamento Stripe
app.post('/conferma-ricarica-stripe', async (req, res) => {
	if (!req.user) {
		req.session.error = 'Utente non autenticato';
		return res.redirect('/gestione-credito');
	}
	
	try {
		const { amount, paymentIntentId } = req.body;
		const totaleRicarica = Number(amount);
		
		const userRef = admin.firestore().collection('users').doc(req.user.uid);
		await userRef.update({
			saldo: admin.firestore.FieldValue.increment(totaleRicarica)
		});
		
		await admin.firestore().collection('ricariche').add({
			userId: req.user.uid,
			importo: totaleRicarica,
			data: admin.firestore.FieldValue.serverTimestamp(),
			metodo: 'Stripe',
			paymentIntentId: paymentIntentId,
			status: 'completed'
		});
		
		req.user.saldo = (req.user.saldo || 0) + totaleRicarica;
		req.session.success = `Ricarica di €${totaleRicarica} effettuata con successo!`;
		res.json({
			success: true,
			message: 'Ricarica effettuata con successo!',
			newBalance: req.user.saldo
		});
		
	} catch (error) {
		console.error('Errore conferma ricarica Stripe:', error);
		req.session.error = 'Errore durante la conferma della ricarica: ' + error.message;
		res.status(500).json({ error: 'Errore durante la conferma della ricarica' });
	}
});

app.get('/profile', (req, res) => {
	if (!req.user) {
		return res.redirect('/login');
	}
	
	res.render('profile', {
		title: 'Profilo Utente',
		currentPage: 'profile'
	});
});

app.get('/rate', async (req, res) => {
	try {
		const tariffe = await firestoreHelpers.getCollection('tariffe');
		
		res.render('rate', {
			title: 'Tariffe',
			currentPage: 'rate',
			tariffe: tariffe
		});
	} catch (error) {
		console.error('Errore nel recuperare le tariffe:', error);
		req.session.error = 'Errore nel recupero delle tariffe';
		return res.redirect('/rate');
	}
});
app.get('/rides', async (req, res) => {
    if (!req.user) {
        return res.redirect('/login');
    }

    try {
        // Recupera tutte le corse dell'utente
        const rides = await firestoreHelpers.getWhere('rides', 'userId', '==', req.user.uid);
        
        // Arricchisci i dati con i nomi dei parcheggi
        const ridesConDettagli = await Promise.all(
            rides.map(async (ride) => {
                const [parcheggioPartenza, parcheggioArrivo] = await Promise.all([
                    firestoreHelpers.getWhere('parcheggi', 'id', '==', ride.parcheggioPartenza),
                    ride.parcheggioArrivo ? 
                        firestoreHelpers.getWhere('parcheggi', 'id', '==', ride.parcheggioArrivo) : 
                        Promise.resolve([])
                ]);

                return {
                    ...ride,
                    parcheggioPartenzaNome: parcheggioPartenza.length > 0 ? 
                        `${parcheggioPartenza[0].nome} - ${parcheggioPartenza[0].via}` : 
                        `Parcheggio ${ride.parcheggioPartenza}`,
                    parcheggioArrivoNome: parcheggioArrivo.length > 0 ? 
                        `${parcheggioArrivo[0].nome} - ${parcheggioArrivo[0].via}` : 
                        (ride.parcheggioArrivo ? `Parcheggio ${ride.parcheggioArrivo}` : null)
                };
            })
        );

        // Ordina dalla più recente alla più vecchia
        ridesConDettagli.sort((a, b) => b.startTime.toDate() - a.startTime.toDate());

        res.render('rides', {
            title: 'Le mie corse - MobiShare',
            currentPage: 'my-rides',
            rides: ridesConDettagli
        });

    } catch (error) {
        console.error('Errore nel recupero delle corse:', error);
        req.session.error = 'Errore nel caricamento della cronologia corse';
        res.render('rides', {
            title: 'Le mie corse - MobiShare',
            currentPage: 'my-rides',
            rides: []
        });
    }
});
app.get('/shop', async (req, res) => {
	try {
		const shopSnap = await admin.firestore().collection('shop').orderBy('credito', 'asc').get();
		const shopItems = shopSnap.docs.map(doc => ({
			id: doc.id,
			...doc.data()
		}));
		
		res.render('shop', { title: 'Shop', currentPage: 'shop', shopItems });
		
	} catch (error) {
		console.error('Errore nel recupero degli item dello shop:', error);
		res.status(500).send('Errore nel recupero degli item dello shop');
	}
});

app.post('/shop/redeem', async (req, res) => {
	if (!req.user) {
		return res.status(401).json({ error: 'Devi essere loggato per riscattare' });
	}
	
	try {
		const { pacchettoId } = req.body;
		const userRef = admin.firestore().collection('users').doc(req.user.uid);
		
		const pacchettoRef = admin.firestore().collection('shop').doc(pacchettoId);
		const pacchettoSnap = await pacchettoRef.get();
		
		if (!pacchettoSnap.exists) {
			return res.status(404).json({ error: 'Pacchetto non trovato' });
		}
		
		const pacchetto = pacchettoSnap.data();
		
		// Recupero utente
		const userSnap = await userRef.get();
		if (!userSnap.exists) {
			return res.status(404).json({ error: 'Utente non trovato' });
		}
		
		const userData = userSnap.data();
		
		// Controllo punti
		if (userData.puntiFedelta < pacchetto.credito) {
			return res.status(400).json({ error: 'Punti insufficienti per riscattare questo pacchetto' });
		}
		
		// Aggiorno utente:
		// - sottraggo i punti fedeltà
		// - aggiungo credito al saldo
		await userRef.update({
			puntiFedelta: userData.puntiFedelta - pacchetto.credito,
			saldo: admin.firestore.FieldValue.increment(pacchetto.costo) // accredito €
		});
		
		// Registro il riscatto
		await admin.firestore().collection('redemptions').add({
			userId: req.user.uid,
			pacchettoId,
			creditoSpeso: pacchetto.credito,
			valoreCredito: pacchetto.costo,
			data: admin.firestore.FieldValue.serverTimestamp()
		});
		
		// Risposta al client con i nuovi valori
		res.json({
			success: true,
			newPoints: userData.puntiFedelta - pacchetto.credito,
			newSaldo: (userData.saldo || 0) + pacchetto.costo
		});
		
	} catch (error) {
		console.error('Errore nel riscatto:', error);
		res.status(500).json({ error: 'Errore durante il riscatto' });
	}
});

app.post('/sessionLogin', async (req, res) => {
	const idToken = req.body.idToken;
	
	if (!idToken) {
		console.error('No ID token provided');
		return res.status(400).json({ status: 'error', message: 'No ID token provided' });
	}
	// Creo un cookie di sessione che dura 1 giorno
	const expiresIn = 60 * 60 * 24  * 1000;
	
	try {
		console.log('Creating session cookie from ID token...');
		const { success, sessionCookie, cookieOptions, error } = await createSessionCookie(idToken, expiresIn);
		
		if (!success) {
			console.error('Failed to create session cookie:', error);
			return res.status(401).json({ status: 'error', message: error.message });
		}
		
		res.cookie('session', sessionCookie, cookieOptions);
		console.log('Session cookie created successfully');
		res.status(200).json({ status: 'success' });
	} catch (error) {
		console.error('Session creation error:', error);
		res.status(401).json({ status: 'error', message: 'Unauthorized' });
	}
});

app.get('/login', (req, res) => {
	if (req.user) {
		return res.redirect('/');
	}
	res.render('login', {
		title: 'MobiShare - Accedi',
		currentPage: 'login'
	});
});

app.post('/login', async (req, res) => {
	const { email, password } = req.body;
	
	if (!email || !password) {
		req.session.error = 'Inserisci email e password';
		return res.redirect('/login');
	}
	
	try {
		const { success, user, error } = await loginUser(email, password);
		
		if (!success) {
			console.error('Login failed:', error);
			req.session.error = error.message;
			return res.redirect('/login');
		}
		
		// Create session with ID token
		const expiresIn = 60 * 60 * 24 * 1000;
		const { success: cookieSuccess, sessionCookie, cookieOptions, error: cookieError } = await createSessionCookie(user.idToken, expiresIn);
		
		if (!cookieSuccess) {
			console.error('Session cookie creation failed:', cookieError);
			req.session.error = 'Errore durante l\'autenticazione. Riprova più tardi.';
			return res.redirect('/login');
		}
		
		res.cookie('session', sessionCookie, cookieOptions);
		return res.redirect('/');
		
	} catch (error) {
		console.error('Login error:', error);
		req.session.error = 'Errore durante il login. Riprova più tardi.';
		return res.redirect('/login');
	}
});

app.get('/logout', (req, res) => {
	res.clearCookie('session', {
		httpOnly: true,
		secure: process.env.NODE_ENV === 'production',
		path: '/',
		sameSite: 'lax'
	});
	res.redirect('/');
});

app.get('/register', (req, res) => {
	if (req.user) {
		return res.redirect('/');
	}
	res.render('register', {
		title: 'MobiShare - Registrati',
		currentPage: 'register'
	});
});

app.post('/register', async (req, res) => {
	const { name, email, password, confirmPassword } = req.body;
	const errors = {};
	
	// Form validation
	if (!name) errors.name = 'Il nome è obbligatorio';
	if (!email) errors.email = 'L\'email è obbligatoria';
	if (!password) errors.password = 'La password è obbligatoria';
	if (password && password.length < 8) errors.password = 'La password deve contenere almeno 8 caratteri';
	if (!confirmPassword) errors.confirmPassword = 'Conferma la tua password';
	if (password !== confirmPassword) errors.confirmPassword = 'Le password non corrispondono';
	
	if (Object.keys(errors).length > 0) {
		req.session.errors = errors;
		req.session.formData = { name, email };
		return res.redirect('/register');
	}
	
	try {
		const { success, user, error } = await registerUser(email, password, name);
		
		if (!success) {
			console.error('Registration failed:', error);
			
			// Handle specific errors from auth.js
			if (error.field) {
				errors[error.field] = error.message;
				req.session.errors = errors;
			} else {
				req.session.generalError = error.message;
			}
			
			req.session.formData = { name, email };
			return res.redirect('/register');
		}
		
		await admin.firestore().collection('users').doc(user.uid).set({
			nome: name,
			email: email,
			ruolo: 'utente',
			saldo: 0,
			puntiFedelta: 0,
			stato_profilo: "attivo",
			startTime: admin.firestore.FieldValue.serverTimestamp()
		});
		
		console.log('User registered successfully, now logging in');
		
		// Use auth helper to login and get ID token
		const loginResult = await loginUser(email, password);
		
		if (!loginResult.success) {
			console.error('Auto-login after registration failed:', loginResult.error);
			req.session.success = 'Account creato con successo! Accedi per continuare.';
			return res.redirect('/login');
		}
		
		// Create session with ID token
		const expiresIn = 60 * 60 * 24 * 5 * 1000; // 5 days
		const { success: cookieSuccess, sessionCookie, cookieOptions, error: cookieError } =
			await createSessionCookie(loginResult.user.idToken, expiresIn);
		
		if (!cookieSuccess) {
			console.error('Session cookie creation failed:', cookieError);
			req.session.success = 'Account creato con successo! Accedi per continuare.';
			return res.redirect('/login');
		}
		
		// Set the cookie
		res.cookie('session', sessionCookie, cookieOptions);
		
		// Redirect to home page with success message
		req.session.success = 'Account creato con successo! Benvenuto su MobiShare!';
		return res.redirect('/');
	} catch (error) {
		console.error('Registration error:', error);
		req.session.generalError = 'Errore durante la registrazione. Riprova più tardi.';
		req.session.formData = { name, email };
		return res.redirect('/register');
	}
});

// Endpoint di test MQTT
app.get('/api/test-mqtt', async (req, res) => {
	if (!mqttClient || !mqttClient.connected) {
		return res.status(503).json({ error: 'Client MQTT non connesso' });
	}
	
	const testMessage = {
		message: 'Test messaggio dal server Node.js',
		timestamp: new Date().toISOString()
	};
	
	mqttClient.publish('mobishare/test', JSON.stringify(testMessage), { qos: 1 }, (err) => {
		if (err) {
			console.error('Errore nella pubblicazione del messaggio di test:', err);
			return res.status(500).json({ error: 'Errore nella pubblicazione del messaggio' });
		}
		console.log('Messaggio di test pubblicato su mobishare/test');
		return res.json({ success: true, message: 'Messaggio di test pubblicato con successo' });
	});
});

app.get('/api/mqtt-token', async (req, res) => {
	if (!req.user) {
		return res.status(401).json({ error: 'Non autenticato' });
	}
	
	try {
		const customToken = await admin.auth().createCustomToken(req.user.uid);
		return res.json({
			uid: req.user.uid,
			customToken
		});
	} catch (error) {
		res.status(500).json({ error: 'Errore nel recupero dei veicoli' });
	}
});


app.get('/stato-batteria-mezzi', requireGestore, async (req, res) => {
    try {

		if (!mqttClient || !mqttClient.connected) {
			await connectMqttClient(req.user.uid, req.user.ruolo);
		}
		
        const [mezzi, parcheggi] = await Promise.all([
            firestoreHelpers.getCollection('mezzi'),
            firestoreHelpers.getCollection('parcheggi')
        ]);
        
        const mezziConBatteria = mezzi.map(m => {
            const tipo = m.tipo || 'Mezzo';
            const id = m.id;
            
            const isElettrico =
                tipo.toLowerCase().includes('elettric') || 
                tipo.toLowerCase().includes('monopattino') ||
                m.isElettrico;
            
            return {
                ...m,
                displayName: `#${id}`,
                batteria: isElettrico ? (m.batteria ?? 0) : null,
                isElettrico: isElettrico
            };
        });
        
        // Ottieni l'ID del mezzo da modificare dal query parameter
        const editingMezzoId = req.query.edit || null;
        
        res.render('stato-batteria-mezzi', {
            mezzi: mezziConBatteria, 
            parcheggi, 
            error: null, 
            success: null,
            editingMezzoId: editingMezzoId  // Passa questa variabile al template
        });
    } catch (e) {
        console.error('Errore stato-batteria-mezzi:', e);
        res.render('stato-batteria-mezzi', {
            mezzi: [], 
            parcheggi: [], 
            error: 'Errore nel recupero mezzi', 
            success: null,
            editingMezzoId: null
        });
    }
});

// Route POST per aggiornare la batteria di un mezzo
app.post('/aggiorna-batteria-mezzo', requireGestore, async (req, res) => {
    const { mezzoId, batteria } = req.body;
        
    if (!mezzoId || batteria === undefined || batteria === null) {
        req.session.error = 'ID mezzo e valore batteria sono obbligatori';
        return res.redirect('/stato-batteria-mezzi');
    }
    
    const batteriaValue = parseInt(batteria);
    
    if (isNaN(batteriaValue) || batteriaValue < 0 || batteriaValue > 100) {
        req.session.error = 'Il valore della batteria deve essere un numero tra 0 e 100';
        return res.redirect('/stato-batteria-mezzi');
    }
    
    try {        
		if (!mqttClient || !mqttClient.connected) {
			await connectMqttClient(req.user.uid, req.user.ruolo);
		}

		await new Promise(resolve => setTimeout(resolve, 1000));

        // Invia comando MQTT per aggiornare lo stato IoT (opzionale)
        if (mqttClient && mqttClient.connected) {
            const comando = {
                action: 'batteria',
                mezzoId: Number(mezzoId),
                batteria: batteriaValue,
                userId: req.user?.uid,
                timestamp: new Date().toISOString()
            };
            
            mqttClient.publish('mobishare/mezzi/comando', JSON.stringify(comando), { qos: 1 }, (err) => {
                if (err) {
                    console.error('Errore pubblicazione MQTT:', err);
                    req.session.error = 'Errore nell\'invio del comando IoT';
                    return res.redirect('/stato-batteria-mezzi');
                }
                
                req.session.success = `Batteria del mezzo ${mezzoId} aggiornata a ${batteriaValue}%`;
                res.redirect('/stato-batteria-mezzi');
            });
        } else {
            // Se MQTT non è connesso, redirect comunque
            console.log('MQTT client non connesso, salto invio comando');
            req.session.success = `Batteria del mezzo ${mezzoId} aggiornata a ${batteriaValue}%`;
            res.redirect('/stato-batteria-mezzi');
        }
        
    } catch (error) {
        console.error('Errore nell\'aggiornamento della batteria:', error);
        req.session.error = 'Errore durante l\'aggiornamento della batteria: ' + error.message;
        res.redirect('/stato-batteria-mezzi');
    }
});

app.get('/products', (req, res) => {
	res.render('mezzi', {
		title: 'MobiShare - Prodotto',
		currentPage: 'products'
	});
});

app.get('/gestione-utenti-sospesi', requireGestore, async(req, res) => {
	try {
		const utenti = await firestoreHelpers.getWhere('users', 'stato_profilo', '==', 'sospeso');
		
		res.render('gestione-utenti-sospesi', {
			title: 'Gestione Utenti Sospesi',
			currentPage: 'utenti-sospesi',
			utenti: utenti,
		});
	} catch (error) {
		console.error('Errore nel recupero degli utenti sospesi:', error);
		req.session.error = 'Errore nel recupero degli utenti sospesi';
		return res.redirect('/gestione-utenti-sospesi');
	}
});

app.post('/sblocca-utente', requireGestore, async (req, res) => {
	const email = req.body.email;
	try {
		await firestoreHelpers.updateByNumericId('users', 'email', email, {
			stato_profilo: 'attivo'
		});
		
		req.session.success = 'Utente sbloccato con successo.';
		res.redirect('/gestione-utenti-sospesi');
	} catch (error) {
		console.error('Errore nello sblocco dell\'utente:', error);
		req.session.error = error.message || 'Errore nello sblocco dell\'utente.';
		res.redirect('/gestione-utenti-sospesi');
	}
});

app.get('/compiti-tecnici', async (req, res) => {
	try {
		const [mezzi, danni] = await Promise.all([
			firestoreHelpers.getCollection('mezzi'),
			firestoreHelpers.getCollection('danni')
		]);
		
		const mezziConDanni = mezzi.map(mezzo => ({
			...mezzo,
			danni: danni.filter(d => d.mezzoId === mezzo.id || d.mezzoId === Number(mezzo.id))
		})).filter(mezzo => mezzo.danni.length > 0);
		
		res.render('compiti-tecnici', {
			title: 'Compiti Tecnici',
			currentPage: null,
			mezziConDanni
		});
	} catch (error) {
		console.error('Errore nel recupero dei danni:', error);
		req.session.error = 'Errore nel recupero dei danni';
		res.render('compiti-tecnici', {
			title: 'Compiti Tecnici',
			currentPage: null,
			mezziConDanni: []
		});
	}
});

app.get('/stato-parcheggio', requireGestore, async (req, res) => {
	try {
		const [mezzi, parcheggiSnapshot] = await Promise.all([
			firestoreHelpers.getCollection('mezzi'),
			db.collection('parcheggi').orderBy('id').get()
		]);
		
		const parcheggi = parcheggiSnapshot.docs.map(doc => ({
			id: doc.id,
			...doc.data(),
			mezzi: mezzi.filter(m => m.id_parcheggio === doc.data().id)
		}));
		
		res.render('stato-parcheggio', {
			title: 'Stato del Parcheggio',
			currentPage: null,
			parcheggi
		});
	} catch (error) {
		console.error('Errore nel recupero dei parcheggi:', error);
		res.render('stato-parcheggio', { title: 'Stato del Parcheggio', currentPage: null, parcheggi: [] });
	}
});

app.post('/aggiungi-parcheggio', async (req, res) => {
	const nome = req.body.nome?.trim();
	const via = req.body.via?.trim();
	
	if (!nome || !via) {
		req.session.error = 'Nome e via sono obbligatori.';
		return res.redirect('/stato-parcheggio');
	}
	
	try {
		// Trova ultimo id
		const snapshot = await admin.firestore()
			.collection('parcheggi')
			.orderBy('id', 'desc')
			.limit(1)
			.get();
		
		let nuovoId = 1;
		if (!snapshot.empty) {
			const last = snapshot.docs[0].data();
			nuovoId = last.id + 1;
		}
		
		const coordinates = await getCoordinates(via);
		
		if (!coordinates) {
			req.session.error = 'Impossibile ottenere le coordinate per l\'indirizzo specificato.';
			return res.redirect('/stato-parcheggio');
		}
		
		await admin.firestore().collection('parcheggi').add({
			id: nuovoId,
			nome,
			via,
			latitudine: coordinates.lat,
			longitudine: coordinates.lon
		});
		
		req.session.success = 'Parcheggio aggiunto con successo.';
		res.redirect('/stato-parcheggio');
		
	} catch (error) {
		console.error('Errore durante creazione parcheggio:', error);
		req.session.error = 'Errore durante la creazione del parcheggio.';
		res.redirect('/stato-parcheggio');
	}
});

app.post('/aggiungi-mezzo', async (req, res) => {
	const { tipo, id_parcheggio } = req.body;
	
	if (!tipo || !id_parcheggio) {
		req.session.error = 'Tipo e parcheggio sono obbligatori.';
		return res.redirect('/stato-parcheggio');
	}
	
	try {
		// Calcolo id incrementale
		const snapshot = await admin.firestore()
			.collection('mezzi')
			.orderBy('id', 'desc')
			.limit(1)
			.get();
		
		let nuovoId = 1;
		if (!snapshot.empty) {
			const last = snapshot.docs[0].data();
			nuovoId = last.id + 1;
		}
		console.log('tipo:', tipo);
		const elettrico = tipo.includes('Elettric');
		const isElettrico = elettrico;
		
		// Costruisci il nuovo mezzo
		const nuovoMezzo = {
			id: nuovoId,
			tipo,
			id_parcheggio: Number(id_parcheggio),
			stato: 'Disponibile',
			isElettrico
		};
		if (elettrico) {
			nuovoMezzo.batteria = 100;
		}
		
		// Inserimento nuovo mezzo
		await admin.firestore().collection('mezzi').add(nuovoMezzo);
		
		req.session.success = 'Mezzo aggiunto con successo.';
		res.redirect('/stato-parcheggio');
	} catch (error) {
		console.error('Errore durante aggiunta mezzo:', error);
		req.session.error = "Errore durante l'aggiunta del mezzo.";
		res.redirect('/stato-parcheggio');
	}
});

app.post('/sposta-mezzo', async (req, res) => {
	const { mezzo_id, parcheggio_destinazione } = req.body;
	
	if (!mezzo_id || !parcheggio_destinazione) {
		req.session.error = 'Dati mancanti per lo spostamento.';
		return res.redirect('/stato-parcheggio');
	}
	
	try {
		const mezziSnap = await admin.firestore()
			.collection('mezzi')
			.where('id', '==', Number(mezzo_id))
			.limit(1)
			.get();
		
		if (mezziSnap.empty) {
			req.session.error = 'Mezzo non trovato.';
			return res.redirect('/stato-parcheggio');
		}
		
		const mezzoRef = mezziSnap.docs[0].ref;
		if(mezziSnap.docs[0].data().stato !== 'Disponibile'){
			req.session.error = 'Il mezzo non è disponibile per lo spostamento.';
			return res.redirect('/stato-parcheggio');
		}
		
		await mezzoRef.update({
			id_parcheggio: Number(parcheggio_destinazione)
		});
		
		req.session.success = 'Mezzo spostato con successo.';
		return res.redirect('/stato-parcheggio');
		
	} catch (error) {
		console.error('Errore nello spostamento del mezzo:', error);
		req.session.error = 'Errore durante lo spostamento del mezzo.';
		return res.redirect('/stato-parcheggio');
	}
});

app.post('/modifica-parcheggio', async (req, res) => {
	const { parcheggio_id, nome, via } = req.body;
	
	if (!parcheggio_id || !nome || !via) {
		req.session.error = 'Dati mancanti per la modifica del parcheggio.';
		return res.redirect('/stato-parcheggio');
	}
	try {
		const parcheggiSnap = await admin.firestore()
			.collection('parcheggi')
			.where('id', '==', Number(parcheggio_id))
			.limit(1)
			.get();
		if (parcheggiSnap.empty) {
			req.session.error = 'Parcheggio non trovato.';
			return res.redirect('/stato-parcheggio');
		}
		const parcheggioRef = parcheggiSnap.docs[0].ref;
		
		// Controlla se ci sono mezzi nel parcheggio
		const mezziSnap = await admin.firestore()
			.collection('mezzi')
			.where('id_parcheggio', '==', Number(parcheggio_id))
			.get();
		
		if (!mezziSnap.empty) {
			req.session.error = 'Non puoi modificare il parcheggio: ci sono ancora mezzi presenti.';
			return res.redirect('/stato-parcheggio');
		}
		
		const coordinates = await getCoordinates(via);
		
		if (!coordinates) {
			req.session.error = 'Impossibile ottenere le coordinate per l\'indirizzo specificato.';
			return res.redirect('/stato-parcheggio');
		}
		await parcheggioRef.update({
			nome: nome,
			via: via,
			latitudine: coordinates.lat,
			longitudine: coordinates.lon
		});
		req.session.success = 'Parcheggio modificato con successo.';
		return res.redirect('/stato-parcheggio');
	} catch (error) {
		console.error('Errore nella modifica del parcheggio:', error);
		req.session.error = 'Errore durante la modifica del parcheggio.';
		return res.redirect('/stato-parcheggio');
	}
});

app.post('/elimina-parcheggio', async (req, res) => {
	const { parcheggio_id } = req.body;
	if (!parcheggio_id) {
		req.session.error = 'ID parcheggio mancante.';
		return res.redirect('/stato-parcheggio');
	}
	try {
		const parcheggiSnap = await admin.firestore()
			.collection('parcheggi')
			.where('id', '==', Number(parcheggio_id))
			.limit(1)
			.get();
		if (parcheggiSnap.empty) {
			req.session.error = 'Parcheggio non trovato.';
			return res.redirect('/stato-parcheggio');
		}
		const parcheggioRef = parcheggiSnap.docs[0].ref;
		// Controlla se ci sono mezzi nel parcheggio
		const mezziSnap = await admin.firestore()
			.collection('mezzi')
			.where('id_parcheggio', '==', Number(parcheggio_id))
			.get();
		if (!mezziSnap.empty) {
			req.session.error = 'Non puoi eliminare il parcheggio: ci sono ancora mezzi presenti.';
			return res.redirect('/stato-parcheggio');
		}
		await parcheggioRef.delete();
		req.session.success = 'Parcheggio eliminato con successo.';
		return res.redirect('/stato-parcheggio');
	} catch (error) {
		console.error('Errore nell\'eliminazione del parcheggio:', error);
		req.session.error = 'Errore durante l\'eliminazione del parcheggio.';
		return res.redirect('/stato-parcheggio');
	}
});

app.post('/elimina-mezzo', async (req, res) => {
	const { mezzo_id } = req.body;
	if (!mezzo_id) {
		req.session.error = 'ID mezzo mancante.';
		return res.redirect('/stato-parcheggio');
	}
	try {
		const mezziSnap = await admin.firestore()
			.collection('mezzi')
			.where('id', '==', Number(mezzo_id))
			.limit(1)
			.get();
		if (mezziSnap.empty) {
			req.session.error = 'Mezzo non trovato.';
			return res.redirect('/stato-parcheggio');
		}
		const mezzoRef = mezziSnap.docs[0].ref;
		if(mezziSnap.docs[0].data().stato !== 'Disponibile'){
			req.session.error = 'Il mezzo non è disponibile per l\'eliminazione.';
			return res.redirect('/stato-parcheggio');
		}
		await mezzoRef.delete();
		req.session.success = 'Mezzo eliminato con successo.';
		return res.redirect('/stato-parcheggio');
	} catch (error) {
		console.error('Errore nell\'eliminazione del mezzo:', error);
		req.session.error = 'Errore durante l\'eliminazione del mezzo.';
		return res.redirect('/stato-parcheggio');
	}
});

app.post('/gestione-credito-sospeso',async (req, res) =>{
	if (!req.user) {
		return res.redirect('/login');
	}
	
	const importo = Number(req.body.importoRicarica);
	
	try {
		await admin.firestore().collection("users").doc(req.user.uid).update({
			saldo: admin.firestore.FieldValue.increment(importo)
		});
		
		await admin.firestore().collection('ricariche').add({
			userId: req.user.uid,
			importo: importo,
			data: admin.firestore.FieldValue.serverTimestamp()
		});
		
		req.session.success = 'Ricarica effettuata con successo!';
		res.redirect('/');
	} catch (error) {
		console.error('Errore durante la ricarica:', error);
		req.session.error = 'Errore durante la ricarica';
		res.redirect('/');
	}
});

app.get('/corsa-attiva', async (req, res) => {
	if (!req.user) return res.redirect('/login');
	
	try {
		const rides = await firestoreHelpers.getWhere('rides', 'userId', '==', req.user.uid);
		const corsaAttiva = rides.find(ride => ride.status === 'attiva');
		
		if (!corsaAttiva) {
			return res.redirect('/avvia-corsa');
		}
		
		const startTime = corsaAttiva.startTime.toDate().toISOString();
		
		res.render('corsa-attiva', {
			title: 'Corsa in corso',
			currentPage: null,
			startTime,
			rideId: corsaAttiva.id,
			mezzoTipo: corsaAttiva.mezzoTipo
		});
	} catch (error) {
		console.error('Errore:', error);
		res.redirect('/avvia-corsa');
	}
});

app.get('/avvia-corsa', async (req, res) => {
	if (!req.user) {
		return res.redirect('/login');
	}
	
	try {
		const rides = await firestoreHelpers.getWhere('rides', 'userId', '==', req.user.uid);
		const corsaAttiva = rides.find(ride => ['attiva', 'in_riepilogo'].includes(ride.status));
		
		if (corsaAttiva) {
			if (corsaAttiva.status === 'attiva') {
				return res.redirect('/corsa-attiva');
			} else if (corsaAttiva.status === 'in_riepilogo') {
				return res.redirect(`/riepilogo-corsa?rideId=${corsaAttiva.id}`);
			}
		}
		
		const [parcheggi, mezzi] = await Promise.all([
			firestoreHelpers.getCollection('parcheggi'),
			firestoreHelpers.getWhere('mezzi', 'stato', '==', 'Disponibile')
		]);
		
		res.render('avvia-corsa', {
			title: 'Avvia Corsa',
			currentPage: null,
			parcheggi,
			mezzi,
			error: req.session.error,
			success: req.session.success
		});
		
		delete req.session.error;
		delete req.session.success;
	} catch (error) {
		console.error('Errore nel recupero dei dati:', error);
		req.session.error = 'Errore nel caricamento dei dati. Riprova più tardi.';
		res.redirect('/avvia-corsa');
	}
});

app.post('/avvia-corsa', async (req, res) => {
	const { mezzoId, parcheggio } = req.body;
	const uid = req.user.uid;
	
	if (!uid || !mezzoId || !parcheggio) {
		req.session.error = 'Dati mancanti per avviare la corsa.';
		return res.redirect('/avvia-corsa');
	}
	
	try {
		const [mezzi, userData] = await Promise.all([
			firestoreHelpers.getWhere('mezzi', 'id', '==', Number(mezzoId)),
			firestoreHelpers.getDoc('users', uid)
		]);
		
		if (mezzi.length === 0) {
			req.session.error = 'Mezzo non trovato.';
			return res.redirect('/avvia-corsa');
		}
		
		const mezzo = mezzi[0];
		
		if (mezzo.stato !== 'Disponibile') {
			req.session.error = 'Il mezzo selezionato non è disponibile.';
			return res.redirect('/avvia-corsa');
		}
		
		if (!userData || userData.saldo <= 0) {
			req.session.error = 'Credito insufficiente per avviare una corsa.';
			return res.redirect('/avvia-corsa');
		}
		
		const mezzoDoc = await admin.firestore()
			.collection('mezzi')
			.where('id', '==', Number(mezzoId))
			.limit(1)
			.get();
		
		if (mezzoDoc.empty) {
			req.session.error = 'Mezzo non trovato.';
			return res.redirect('/avvia-corsa');
		}
		
		await Promise.all([
			admin.firestore().collection('rides').add({
				userId: uid,
				mezzoId: Number(mezzoId),
				mezzoTipo: mezzo.tipo,
				mezzoElettrico: mezzo.isElettrico || false,
				parcheggioPartenza: Number(parcheggio),
				startTime: admin.firestore.FieldValue.serverTimestamp(),
				status: 'attiva',
			}),
			mezzoDoc.docs[0].ref.update({
				stato: 'In uso'
			})
		]);
		
		if (!mqttClient || !mqttClient.connected) {
			await connectMqttClient(uid, req.user.ruolo);
		}
		
		const comando = {
			action: 'in_uso',
			mezzoId: Number(mezzoId),
			userId: uid,
			timestamp: new Date().toISOString()
		};
		
		mqttClient.publish('mobishare/mezzi/comando', JSON.stringify(comando), { qos: 1 });
		res.redirect('/corsa-attiva');
		
	} catch (error) {
		console.error('Errore avvio corsa:', error);
		req.session.error = 'Errore durante l\'avvio della corsa.';
		res.redirect('/avvia-corsa');
	}
});

app.post('/termina-corsa', async (req, res) => {
	const uid = req.user?.uid;
	
	if (!uid) {
		return res.redirect('/login');
	}
	
	try {
		const ridesAttive = await firestoreHelpers.getWhere('rides', 'userId', '==', uid);
		const corsaAttiva = ridesAttive.find(ride => ride.status === 'attiva');
		
		if (!corsaAttiva) {
			req.session.error = 'Nessuna corsa attiva trovata.';
			return res.redirect('/avvia-corsa');
		}
		
		const startTime = corsaAttiva.startTime.toDate();
		const endTime = new Date();
		const durataMinuti = Math.ceil((endTime - startTime) / 60000);
		
		const [tariffe, mezzi] = await Promise.all([
			firestoreHelpers.getWhere('tariffe', 'mezzo', '==', corsaAttiva.mezzoTipo),
			firestoreHelpers.getWhere('mezzi', 'id', '==', corsaAttiva.mezzoId)
		]);
		
		let costo = 0;
		if (tariffe.length > 0) {
			const tariffa = tariffe[0];
			if (durataMinuti <= 30) {
				costo = parseFloat(tariffa.costoFisso + tariffa.mezzora);
			} else {
				const minutiExtra = durataMinuti - 30;
				costo = parseFloat((tariffa.mezzora + tariffa.costoFisso + minutiExtra * tariffa.costoMinuto).toFixed(2));
			}
		}
		
		let nuovaBatteria = null;
		if (mezzi.length > 0) {
			const mezzo = mezzi[0];
			if (typeof mezzo.batteria === 'number' && mezzo.isElettrico) {
				let consumo = 0;
				if (mezzo.tipo.includes('Monopattino')) {
					consumo = Math.ceil(durataMinuti); // 1% al minuto
				} else if (mezzo.tipo.includes('Bicicletta')) {
					consumo = Math.ceil(durataMinuti / 2); // 0.5% al minuto
				}
				nuovaBatteria = Math.max(0, mezzo.batteria - consumo);
			}
		}
		
		const puntiCorsa = 1 + (costo * 0.1);
		
		const rideAttiva = await firestoreHelpers.getWhere('rides', 'userId', '==', uid)
			.then(rides => rides.find(ride => ride.status === 'attiva'));
		
		if (!rideAttiva) {
			req.session.error = 'Corsa non trovata.';
			return res.redirect('/avvia-corsa');
		}
		
		const updatePromises = [
			await db.collection('rides').doc(rideAttiva.id).update({
				endTime: admin.firestore.FieldValue.serverTimestamp(),
				status: 'in_riepilogo',
				costo: costo,
				durataMinuti: durataMinuti,
				batteriaFinale: nuovaBatteria,
				puntiCorsa: Number(puntiCorsa.toFixed(2))
			})
		];
		
		if (nuovaBatteria !== null && mezzi.length > 0) {
			updatePromises.push(
				firestoreHelpers.updateByNumericId('mezzi', 'id', corsaAttiva.mezzoId, {
					batteria: nuovaBatteria
				})
			);
		}
		
		await Promise.all(updatePromises);
		
		res.redirect(`/riepilogo-corsa?rideId=${rideAttiva.id}`);
	} catch (err) {
		console.error('Errore nel terminare la corsa:', err);
		req.session.error = 'Errore nel terminare la corsa: ' + err.message;
		res.redirect('/avvia-corsa');
	}
});

async function gestisciScadenzaCorsa(rideId) {
	try {
		const rideData = await firestoreHelpers.getDoc('rides', rideId);
		
		if (!rideData || rideData.status !== 'in_riepilogo') {
			return;
		}
		const user = await firestoreHelpers.getDoc('users', rideData.userId);
		const costo = rideData.costo || 0;
		const saldoUtente = user?.saldo || 0;
		console.log(`entro gestione scadenza corsa per rideId ${rideId}, userId ${rideData.userId}, costo ${costo}, saldoUtente ${saldoUtente}`);
		
		const tuttiParcheggi = await firestoreHelpers.getCollection('parcheggi');
		const parcheggioRandom = tuttiParcheggi.length > 0
			? tuttiParcheggi[Math.floor(Math.random() * tuttiParcheggi.length)].id
			: rideData.parcheggioPartenza;
		
		console.log(`Assegnato parcheggio random: ${parcheggioRandom} per mezzo ${rideData.mezzoId}`);
		
		if (saldoUtente >= costo) {
			const saldoPostCorsa = Number((saldoUtente - costo).toFixed(2));
			const puntiGuadagnati = rideData.puntiCorsa || 0;
			const puntiPostCorsa = Number(((user?.puntiFedelta || 0) + puntiGuadagnati).toFixed(2));
			
			await firestoreHelpers.updateByNumericId('users', 'email', user.email, {
				saldo: saldoPostCorsa,
				puntiFedelta: puntiPostCorsa,
				ultimaCorsa: admin.firestore.FieldValue.serverTimestamp()
			});
			
			await db.collection('rides').doc(rideId).update({
				status: 'completata_automatica',
				parcheggioArrivo: parcheggioRandom,
				dataCompletamento: admin.firestore.FieldValue.serverTimestamp(),
				note: `Corsa completata automaticamente per scadenza timer. Mezzo parcheggiato in posizione random.`
			});
			
			await firestoreHelpers.updateByNumericId('mezzi', 'id', rideData.mezzoId, {
				stato: 'Disponibile',
				id_parcheggio: parcheggioRandom,
				batteria: rideData.mezzoElettrico ? 100 : admin.firestore.FieldValue.delete(),
				danni: [],
				ultimoUtilizzo: admin.firestore.FieldValue.serverTimestamp()
			});
			console.log(`Corsa ${rideId} completata automaticamente per utente ${rideData.userId}, mezzo parcheggiato in ${parcheggioRandom}`);
			
			return true;
		} else {
			await firestoreHelpers.updateByNumericId('users', 'email', user.email, {
				stato_profilo: 'sospeso',
				numeroSospensioni: admin.firestore.FieldValue.increment(1)
			});
			
			await db.collection('rides').doc(rideId).update({
				status: 'annullata',
				parcheggioArrivo: parcheggioRandom,
				motivoAnnullamento: 'Tempo scaduto per il pagamento - Saldo insufficiente',
				note: `La corsa è stata annullata automaticamente dopo scadenza timer con saldo insufficiente. Mezzo parcheggiato in posizione random.`
			});
			
			await firestoreHelpers.updateByNumericId('mezzi', 'id', rideData.mezzoId, {
				stato: 'Disponibile',
				id_parcheggio: parcheggioRandom,
				batteria: rideData.mezzoElettrico ? 100 : admin.firestore.FieldValue.delete(),
				danni: [],
				ultimoUtilizzo: admin.firestore.FieldValue.serverTimestamp()
			});
			
			console.log(`Corsa ${rideId} annullata per saldo insufficiente, utente ${rideData.userId} sospeso, mezzo parcheggiato in ${parcheggioRandom}`);
			return false;
		}
	} catch (error) {
		console.error('Errore nella gestione automatica della scadenza corsa:', error);
		return false;
	}
}

app.get('/riepilogo-corsa', async (req, res) => {
	if (!req.user) return res.redirect('/login');
	
	const rideId = req.query.rideId;
	if (!rideId) {
		req.session.error = 'ID corsa non specificato';
		return res.redirect('/avvia-corsa');
	}
	
	try {
		const rideData = await firestoreHelpers.getDoc('rides', rideId);
		
		if (!rideData) {
			req.session.error = 'Corsa non trovata';
			return res.redirect('/avvia-corsa');
		}
		
		if (rideData.userId !== req.user.uid) {
			req.session.error = 'Accesso non autorizzato';
			return res.redirect('/avvia-corsa');
		}
		
		if (rideData.status === 'completata_automatica') {
			return res.redirect(`/ricevuta-corsa?rideId=${rideId}&automatica=true`);
		}
		
		if (rideData.status !== 'in_riepilogo') {
			if (rideData.status === 'annullata') {
				req.session.error = 'Corsa annullata per scadenza tempo';
				return res.redirect('/avvia-corsa');
			}
			req.session.error = 'Corsa non valida per il riepilogo';
			return res.redirect('/avvia-corsa');
		}
		
		const riepilogoStartTime = rideData.endTime.toDate();
		const now = new Date();
		const tempoMassimoPerPagamento = 20;
		const endTime = new Date(riepilogoStartTime.getTime() + tempoMassimoPerPagamento * 60 * 1000);
		
		let diffMs = endTime - now;
		let diffMinutes = Math.floor(diffMs / (1000 * 60));
		let diffSeconds = Math.floor(diffMs / 1000);
		
		if (diffSeconds < 0) diffSeconds = 0;
		if (diffMinutes < 0) diffMinutes = 0;
		
		if (diffSeconds === 0) {
			const costo = rideData.costo || 0;
			const saldoUtente = req.user.saldo || 0;
			
			if (saldoUtente >= costo) {
				const completata = await gestisciScadenzaCorsa(rideId);
				if (completata) {
					return res.redirect(`/ricevuta-corsa?rideId=${rideId}&automatica=true`);
				}
			}
		}
		
		const costo = rideData.costo || 0;
		const importoRimanente = Math.max(0, costo - (req.user.saldo || 0));
		
		const parcheggiPartenza = await firestoreHelpers.getWhere('parcheggi', 'id', '==', rideData.parcheggioPartenza);
		const parcheggioPartenza = parcheggiPartenza.length > 0 ?
			`${parcheggiPartenza[0].nome} – ${parcheggiPartenza[0].via}` : 'Sconosciuto';		const parcheggi = await firestoreHelpers.getCollection('parcheggi');
		const possibileGuadagno = rideData.puntiCorsa || 0;
		
		const rideForTemplate = {
			id: rideId,
			...rideData,
			startTime: rideData.startTime.toDate().toLocaleString('it-IT'),
			endTime: rideData.endTime.toDate().toLocaleString('it-IT'),
			parcheggioPartenza,
			danni: [],
			importoRimanente,
			minutiRimanenti: diffMinutes,
			secondiRimanenti: diffSeconds,
			endTimeISO: endTime.toISOString(),
			devePagare: importoRimanente > 0,
			puntiGuadagnati: rideData.puntiCorsa || 0,
			batteria: rideData.batteriaFinale !== undefined ? rideData.batteriaFinale : null
		};
		
		res.render('riepilogo-corsa', {
			title: 'Riepilogo e Termina Corsa',
			currentPage: null,
			ride: rideForTemplate,
			parcheggi,
			isMezzoElettrico: rideData.mezzoElettrico,
			user: req.user,
			possibileGuadagno,
			stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY
		});
	} catch (error) {
		console.error('Errore recupero riepilogo corsa:', error);
		req.session.error = 'Errore nel recupero dei dettagli della corsa';
		res.redirect('/avvia-corsa');
	}
});

app.post('/conferma-termine-corsa', async (req, res) => {
	const { rideId, parcheggioArrivo, feedback, danni, dannoAltro } = req.body;
	const uid = req.user?.uid;
	
	if (!uid) return res.redirect('/login');
	if (!rideId) {
		req.session.error = 'ID corsa mancante';
		return res.redirect('/avvia-corsa');
	}
	
	try {
		const ride = await firestoreHelpers.getDoc('rides', rideId);
		
		if (!ride) {
			req.session.error = 'Corsa non trovata';
			return res.redirect('/avvia-corsa');
		}
		
		if (ride.userId !== uid) {
			req.session.error = 'Accesso non autorizzato a questa corsa';
			return res.redirect('/avvia-corsa');
		}
		
		if (ride.status !== 'in_riepilogo') {
			req.session.error = 'Corsa non valida per la conferma';
			return res.redirect('/avvia-corsa');
		}
		
		const costo = ride.costo || 0;
		const puntiGuadagnati = ride.puntiCorsa || 0;
		const batteriaFinale = ride.batteriaFinale || null;
		
		let danniMultipli = danni || [];
		if (!Array.isArray(danniMultipli)) danniMultipli = [danniMultipli];
		if (dannoAltro?.trim()) danniMultipli.push(dannoAltro.trim());
		
		const mezzi = await firestoreHelpers.getWhere('mezzi', 'id', '==', ride.mezzoId);
		
		if (batteriaFinale !== null && batteriaFinale < 15 && ride.mezzoElettrico) {
			if (!danniMultipli.includes('Batteria scarica')) danniMultipli.push('Batteria scarica');
		}
		
		const user = await firestoreHelpers.getDoc('users', uid);
		const nomeUtente = user?.nome || uid;
		
		const saldoPostCorsa = Number(((user?.saldo || 0) - costo).toFixed(2));
		const puntiPostCorsa = Number(((user?.puntiFedelta || 0) + puntiGuadagnati).toFixed(2));
		
		const updatePromises = [];

		updatePromises.push(
			db.collection('rides').doc(rideId).update({
				parcheggioArrivo: Number(parcheggioArrivo),
				batteria: batteriaFinale,
				danni: danniMultipli.join(', '),
				feedback: feedback || '',
				dataConferma: admin.firestore.FieldValue.serverTimestamp(),
				status: 'completata',
				dataCompletamento: admin.firestore.FieldValue.serverTimestamp()
			})
		);
		
		if (danniMultipli.length > 0 && danniMultipli[0] !== '') {
			for (const tipoDanno of danniMultipli) {
				if (tipoDanno?.trim()) {
					updatePromises.push(
						db.collection('danni').add({
							mezzoId: ride.mezzoId,
							parcheggio: Number(parcheggioArrivo),
							tipoDanno: tipoDanno.trim(),
							segnalatoDa: nomeUtente,
							dataSegnalazione: admin.firestore.FieldValue.serverTimestamp(),
							rideId
						})
					);
				}
			}
		}
		
		let nuovoStatoMezzo = (danniMultipli.length > 0 && danniMultipli[0] !== '') ? 'Non disponibile' : 'Disponibile';
		
		if (mezzi.length > 0) {
			updatePromises.push(
				firestoreHelpers.updateByNumericId('mezzi', 'id', ride.mezzoId, {
					stato: nuovoStatoMezzo,
					id_parcheggio: Number(parcheggioArrivo),
					ultimoUtilizzo: admin.firestore.FieldValue.serverTimestamp()
				})
			);
		}
		
		const userUpdates = {
			puntiFedelta: puntiPostCorsa,
			saldo: saldoPostCorsa,
			ultimaCorsa: admin.firestore.FieldValue.serverTimestamp()
		};
		
		if (saldoPostCorsa < 0) {
			userUpdates.stato_profilo = 'sospeso';
			userUpdates.numeroSospensioni = admin.firestore.FieldValue.increment(1);
		}
		
		updatePromises.push(
			db.collection('users').doc(uid).update(userUpdates)
		);
		
		await Promise.all(updatePromises);

		if (req.user) {
			req.user.saldo = saldoPostCorsa;
			req.user.puntiFedelta = puntiPostCorsa;
		}
		
		if (mezzi.length > 0 && (!mqttClient || !mqttClient.connected)) {
			await connectMqttClient(uid, req.user.ruolo);
		}
		
		if (mqttClient && mqttClient.connected) {
			const comando = {
				action: nuovoStatoMezzo === 'Disponibile' ? 'sblocca' : 'blocca',
				mezzoId: ride.mezzoId,
				userId: uid,
				timestamp: new Date().toISOString()
			};
			
			try {
				mqttClient.publish('mobishare/mezzi/comando', JSON.stringify(comando), { qos: 1 });
			} catch (mqttError) {
				console.error('Errore pubblicazione MQTT:', mqttError);
			}
		}
		
		res.redirect(`/ricevuta-corsa?rideId=${rideId}`);
	} catch (err) {
		console.error('Errore nella conferma della corsa:', err);
		req.session.error = 'Errore nella conferma della corsa';
		res.redirect('/avvia-corsa');
	}
});

app.get('/ricevuta-corsa', async (req, res) => {
	if (!req.user) return res.redirect('/login');
	
	const rideId = req.query.rideId;
	const automatica = req.query.automatica === 'true';
	
	if (!rideId) {
		req.session.error = 'ID corsa non specificato';
		return res.redirect('/');
	}
	
	try {
		const rideData = await firestoreHelpers.getDoc('rides', rideId);
		
		if (!rideData) {
			req.session.error = 'Corsa non trovata';
			return res.redirect('/');
		}
		
		if (rideData.userId !== req.user.uid) {
			req.session.error = 'Accesso non autorizzato';
			return res.redirect('/');
		}
		
		if (rideData.status !== 'completata' && rideData.status !== 'completata_automatica') {
			req.session.error = 'Corsa non completata';
			return res.redirect('/');
		}
		
		const [parcheggioPartenzaData, parcheggioArrivoData] = await Promise.all([
			firestoreHelpers.getWhere('parcheggi', 'id', '==', rideData.parcheggioPartenza),
			rideData.parcheggioArrivo ?
				firestoreHelpers.getWhere('parcheggi', 'id', '==', rideData.parcheggioArrivo) :
				Promise.resolve([])
		]);
		
		const parcheggioPartenzaNome = parcheggioPartenzaData.length > 0 ? parcheggioPartenzaData[0].nome : `Parcheggio ${rideData.parcheggioPartenza}`;
		const parcheggioArrivoNome = parcheggioArrivoData.length > 0 ? parcheggioArrivoData[0].nome :
			(rideData.parcheggioArrivo ? `Parcheggio ${rideData.parcheggioArrivo}` : 'Non specificato');
		
		const rideForTemplate = {
			id: rideId,
			...rideData,
			startTime: rideData.startTime.toDate().toLocaleString('it-IT'),
			endTime: rideData.endTime.toDate().toLocaleString('it-IT'),
			durataMinuti: rideData.durataMinuti || 0,
			costo: rideData.costo || 0,
			puntiGuadagnati: rideData.puntiCorsa || 0,
			danni: rideData.danni ? rideData.danni.split(', ').filter(d => d.trim()) : [],
			completataAutomaticamente: automatica || rideData.status === 'completata_automatica',
			parcheggioPartenzaNome: parcheggioPartenzaNome,
			parcheggioArrivoNome: parcheggioArrivoNome
		};
		
		res.render('ricevuta-corsa', {
			title: 'Corsa Completata - MobiShare',
			currentPage: null,
			ride: rideForTemplate,
			user: req.user
		});
		
	} catch (error) {
		console.error('Errore conferma corsa:', error);
		req.session.error = 'Errore nel caricamento della conferma';
		res.redirect('/');
	}
});

app.post('/danno-risolto', async (req, res) => {
	const { dannoId, mezzoId } = req.body;
	try {
		await db.collection('danni').doc(dannoId).delete();
		const danniRimanenti = await firestoreHelpers.getWhere('danni', 'mezzoId', '==', Number(mezzoId));
		console.log('Danni rimanenti:', danniRimanenti.length);
		
		if (danniRimanenti.length === 0) {
			console.log('Nessun danno rimanente, impostando mezzo come disponibile');
			await firestoreHelpers.updateByNumericId('mezzi', 'id', Number(mezzoId), {
				stato: 'Disponibile'
			});
		}
		res.redirect('/compiti-tecnici');
	} catch (error) {
		console.error('Stack trace:', error.stack);
		req.session.error = 'Errore nella risoluzione del danno: ' + error.message;
		res.redirect('/compiti-tecnici');
	}
});

app.get('/feedback', async(req, res) => {
	try {
		const rides = await firestoreHelpers.getWhere('rides', 'feedback', '!=', null);
		rides.sort((a, b) => b.endTime.toDate() - a.endTime.toDate());
		
		const userIds = [...new Set(rides.map(ride => ride.userId))];
		const userDocs = await Promise.all(
			userIds.map(uid => firestoreHelpers.getDoc('users', uid))
		);
		
		const userIdToNome = {};
		userDocs.forEach((user, i) => {
			if (user) userIdToNome[userIds[i]] = user.nome || userIds[i];
		});
		
		const feedbacks = rides
			.filter(ride => ride.feedback && ride.feedback.trim().length > 0)
			.map(ride => ({
				nome: userIdToNome[ride.userId] || ride.userId,
				testo: ride.feedback,
				danni: Array.isArray(ride.danni) ? ride.danni :
					(typeof ride.danni === 'string' && ride.danni.length > 0 ?
						ride.danni.split(',').map(d => d.trim()) : []),
				endTime: ride.endTime.toDate().toLocaleString('it-IT')
			}));
		
		res.render('feedback', {
			title: 'Feedback',
			currentPage: 'feedback',
			feedbacks
		});
	} catch (error) {
		console.error('Errore nel recupero dei feedback:', error);
		req.session.error = 'Errore nel recupero dei feedback';
		return res.redirect('/feedback');
	}
});

/*
 IOT - MQTT
 */
app.post('/iot/blocca-mezzo', requireGestore, async (req, res) => {
	const { mezzoId, redirectTo } = req.body;
	if (!mezzoId) {
		req.session.error = 'ID mezzo mancante';
		return res.redirect('/' + (redirectTo || 'stato-parcheggio'));
	}
	
	try {
		const comando = {
			action: 'blocca',
			mezzoId: Number(mezzoId),
			userId: req.user.uid,
			timestamp: new Date().toISOString()
		};
		
		if (!mqttClient || !mqttClient.connected) {
			await connectMqttClient(req.user.uid);
		}
		
		mqttClient.publish('mobishare/mezzi/comando', JSON.stringify(comando), { qos: 1 }, (err) => {
			if (err) {
				console.error('Errore pubblicazione MQTT:', err);
				req.session.error = 'Errore nell\'invio del comando IoT';
				return res.redirect('/' + (redirectTo || 'stato-parcheggio'));
			}
			
			req.session.success = 'Comando di blocco inviato al mezzo!';
			return res.redirect('/' + (redirectTo || 'stato-parcheggio'));
		});
		
	} catch (error) {
		console.error('Errore blocco mezzo:', error);
		req.session.error = 'Errore nell\'invio del comando IoT';
		return res.redirect('/' + (redirectTo || 'stato-parcheggio'));
	}
});

app.post('/iot/sblocca-mezzo', requireGestore, async (req, res) => {
	const { mezzoId, redirectTo } = req.body;
	if (!mezzoId) {
		req.session.error = 'ID mezzo mancante';
		return res.redirect('/' + (redirectTo || 'stato-parcheggio'));
	}
	
	try {
		const comando = {
			action: 'sblocca',
			mezzoId: Number(mezzoId),
			userId: req.user.uid,
			timestamp: new Date().toISOString()
		};
		
		if (!mqttClient || !mqttClient.connected) {
			await connectMqttClient(req.user.uid);
		}
		
		mqttClient.publish('mobishare/mezzi/comando', JSON.stringify(comando), { qos: 1 }, (err) => {
			if (err) {
				console.error('Errore pubblicazione MQTT:', err);
				req.session.error = 'Errore nell\'invio del comando IoT';
				return res.redirect('/' + (redirectTo || 'stato-parcheggio'));
			}
			
			req.session.success = 'Comando di sblocco inviato al mezzo!';
			return res.redirect('/' + (redirectTo || 'stato-parcheggio'));
		});
		
	} catch (error) {
		console.error('Errore sblocco mezzo:', error);
		req.session.error = 'Errore nell\'invio del comando IoT';
		return res.redirect('/' + (redirectTo || 'stato-parcheggio'));
	}
});

app.post('/prenota-mezzo', async (req, res) => {
	if (!req.user) {
		return res.status(401).json({ error: 'Devi essere loggato' });
	}
	
	const { mezzoId } = req.body;
	if (!mezzoId) {
		return res.status(400).json({ error: 'ID mezzo mancante' });
	}
	
	try {
		if (!mqttClient || !mqttClient.connected) {
			await connectMqttClient(req.user.uid);
		}
		
		const prenotazione = {
			mezzoId: Number(mezzoId),
			userId: req.user.uid,
			timestamp: new Date().toISOString()
		};
		
		mqttClient.publish('mobishare/mezzi/prenotazione', JSON.stringify(prenotazione), { qos: 1 }, (err) => {
			if (err) {
				console.error('Errore pubblicazione prenotazione:', err);
				return res.status(500).json({ error: 'Errore nella prenotazione' });
			}
			
			// Ascolta la risposta
			mqttClient.subscribe('mobishare/mezzi/risposta', (err) => {
				if (err) {
					console.error('Errore sottoscrizione risposta:', err);
					return res.status(500).json({ error: 'Errore nella prenotazione' });
				}
			});
			
			// Timeout per la risposta
			const timeout = setTimeout(() => {
				res.status(408).json({ error: 'Timeout nella risposta del sistema' });
			}, 10000);
			
			// Gestione risposta
			const handleMessage = (topic, message) => {
				if (topic === 'mobishare/mezzi/risposta') {
					try {
						const response = JSON.parse(message.toString());
						if (response.mezzoId === Number(mezzoId) && response.userId === req.user.uid) {
							clearTimeout(timeout);
							mqttClient.removeListener('message', handleMessage);
							
							if (response.autorizzato) {
								res.json({ success: true, message: 'Mezzo sbloccato con successo!' });
							} else {
								res.status(403).json({ error: 'Mezzo non disponibile o credito insufficiente' });
							}
						}
					} catch (e) {
						console.error('Errore parsing risposta:', e);
					}
				}
			};
			
			mqttClient.on('message', handleMessage);
		});
		
	} catch (error) {
		console.error('Errore prenotazione:', error);
		res.status(500).json({ error: 'Errore nella prenotazione' });
	}
});

app.post('/create-payment-intent', async (req, res) => {
	if (!req.user) {
		req.session.error = 'Utente non autenticato';
		return res.redirect('/gestione-credito');
	}
	
	try {
		const { amount } = req.body;
		
		// centesimi (Stripe lavora con la valuta più piccola)
		const amountInCents = Math.round(amount * 100);
		
		const paymentIntent = await stripe.paymentIntents.create({
			amount: amountInCents,
			currency: 'eur',
			metadata: {
				userId: req.user.uid,
				email: req.user.email
			},
			payment_method_types: ['card'],
		});
		
		res.json({
			clientSecret: paymentIntent.client_secret,
			paymentIntentId: paymentIntent.id
		});
	} catch (error) {
		console.error('Errore creazione Payment Intent:', error);
		req.session.error = 'Errore nella creazione del pagamento: ' + error.message;
		res.status(500).json({ error: 'Errore nella creazione del pagamento' });
	}
});

app.get('/chatbot', async (req, res) => {
	if (!req.user) return res.redirect('/login');

	res.render('chatbot', {
		title: 'Assistente Virtuale - MobiShare',
		currentPage: 'chatbot',
		user: req.user
	});
});
// CV-EMBEDDING
app.post('/api/verify-password', async (req, res) => {
	if (!req.user) {
		return res.status(401).json({ error: 'Utente non autenticato' });
	}

	const { password } = req.body;

	try {
		const { success } = await loginUser(req.user.email, password);

		if (success) {
			res.json({ success: true, message: 'Password verificata' });
		} else {
			res.status(401).json({ error: 'Password non valida' });
		}
	} catch (error) {
		console.error('Errore verifica password:', error);
		res.status(500).json({ error: 'Errore nella verifica' });
	}
});

app.post('/api/face-recognition/register', async (req, res) => {
	if (!req.user) {
		return res.status(401).json({ error: 'Utente non autenticato' });
	}

	if (!req.files || !req.files.image) {
		return res.status(400).json({ error: 'Nessuna immagine fornita' });
	}

	try {
		const formData = new FormData();
		const imageBuffer = req.files.image.data;

		formData.append('image', imageBuffer, {
			filename: 'face.jpg',
			contentType: 'image/jpeg'
		});

		const pythonResponse = await axios.post(
			'http://localhost:7777/api/ai-bridge/face_recognition/register',
			formData,
			{
				headers: {
					...formData.getHeaders(),
					username: req.user.uid
				},
				timeout: 30000
			}
		);

		if (pythonResponse.data.status === 'success') {
			await admin.firestore().collection('users').doc(req.user.uid).update({
				faceRegistered: true,
				faceRegistrationDate: admin.firestore.FieldValue.serverTimestamp()
			});

			res.json({ success: true, message: 'Volto registrato con successo' });
		} else {
			throw new Error(pythonResponse.data.detail);
		}
	} catch (error) {
		console.error('Errore registrazione facciale:', error);

		if (error.response) {
			res.status(error.response.status).json({
				error: error.response.data.detail || 'Errore nel servizio di riconoscimento facciale'
			});
		} else {
			res.status(500).json({
				error: 'Servizio di riconoscimento facciale non disponibile'
			});
		}
	}
});

app.post('/api/face-recognition/verify', async (req, res) => {
	if (!req.user) {
		return res.status(401).json({ error: 'Utente non autenticato' });
	}

	if (!req.files || !req.files.image) {
		return res.status(400).json({ error: 'Nessuna immagine fornita' });
	}

	try {
		const userDoc = await admin.firestore().collection('users').doc(req.user.uid).get();
		const userData = userDoc.data();

		if (!userData?.faceRegistered) {
			return res.status(400).json({ error: 'Utente non registrato per il riconoscimento facciale' });
		}

		const formData = new FormData();
		const imageBuffer = req.files.image.data;
		formData.append('image', imageBuffer, {
			filename: 'verify_face.jpg',
			contentType: 'image/jpeg'
		});

		const pythonResponse = await axios.post(
			'http://localhost:7777/api/ai-bridge/face_recognition/verify',
			formData,
			{
				headers: {
					...formData.getHeaders(),
					username: req.user.uid
				},
				timeout: 30000
			}
		);

		res.json({
			success: true,
			verified: pythonResponse.data.verified
		});
	} catch (error) {
		console.error('Errore verifica facciale:', error);

		if (error.response) {
			res.status(error.response.status).json({
				error: error.response.data.detail || 'Errore nella verifica facciale'
			});
		} else {
			res.status(500).json({
				error: 'Servizio di riconoscimento facciale non disponibile'
			});
		}
	}
});

app.get('/api/face-recognition/status', async (req, res) => {
	if (!req.user) {
		return res.status(401).json({ error: 'Utente non autenticato' });
	}

	try {
		const userDoc = await admin.firestore().collection('users').doc(req.user.uid).get();
		const userData = userDoc.data();

		res.json({
			faceRegistered: userData?.faceRegistered || false,
			registrationDate: userData?.faceRegistrationDate?.toDate() || null
		});
	} catch (error) {
		console.error('Errore verifica stato:', error);
		res.status(500).json({ error: 'Errore nel recupero dello stato' });
	}
});

app.delete('/api/face-recognition/delete', async (req, res) => {
	if (!req.user) {
		return res.status(401).json({ error: 'Utente non autenticato' });
	}

	try {
		const faceEncodings = await admin.firestore()
		.collection('face_encodings')
		.where('username', '==', req.user.uid)
		.get();

		const deletePromises = faceEncodings.docs.map(doc => doc.ref.delete());
		await Promise.all(deletePromises);

		await admin.firestore().collection('users').doc(req.user.uid).update({
			faceRegistered: false,
			faceRegistrationDate: admin.firestore.FieldValue.delete()
		});

		res.json({
			success: true,
			message: 'Registrazione facciale eliminata con successo',
			deletedEncodings: faceEncodings.size
		});

	} catch (error) {
		console.error('Errore eliminazione:', error);
		res.status(500).json({ error: 'Errore nell\'eliminazione della registrazione' });
	}
});

//LLM
app.post('/api/chatbot/query', async (req, res) => {
	if (!req.user) {
		return res.status(401).json({ error: 'Utente non autenticato' });
	}

	try {
		const { query, conversation_id } = req.body;

		const response = await axios.post(
			'http://localhost:7777/api/ai-bridge/chatbot/query',
			{ query, conversation_id },
			{
				headers: {
					'user-id': req.user.uid,
					'user-role': req.user.ruolo
				}
			}
		);
		res.json(response.data);
	} catch (error) {
		console.error('Errore chatbot:', error);
		res.status(500).json({
			error: 'Errore nel servizio chatbot',
			details: error.message
		});
	}
});

//ML
app.get('/api/predizioni/distribuzione-ottimale', requireGestore, async (req, res) => {
    try {
        const response = await axios.get('http://localhost:7777/api/ai-bridge/ml-predictions/park_suggestions');
        res.json(response.data);
    } catch (error) {
        console.error('Errore recupero predizioni:', error);
        res.status(500).json({ error: 'Errore nel recupero delle predizioni, verifica che il servizio AI sia online'});
    }
});

app.post('/api/predizioni/addestra-modello', requireGestore, async (req, res) => {
    try {
        const response = await axios.post(
            'http://localhost:7777/api/ai-bridge/ml-predictions/train',
            {},
            { headers: { 'Content-Type': 'application/json' } }
        );
        res.json(response.data);
    } catch (error) {
        console.error('Errore addestramento modello:', error);
        res.status(500).json({ error: "Errore nell'addestramento del modello" });
    }
});

app.get('/api/predizioni/cache-status', requireGestore, async (req, res) => {
    try {
        const response = await axios.get('http://localhost:7777/api/ai-bridge/ml-predictions/cache/status');
        const cacheData = response.data;

        if (cacheData.cache_available && cacheData.generated_at) {
            let generatedAt;
            if (cacheData.generated_at._seconds) {
                generatedAt = new Date(cacheData.generated_at._seconds * 1000);
            } else {
                generatedAt = new Date(cacheData.generated_at);
            }

            cacheData.formatted_date = generatedAt.toLocaleString('it-IT');
            cacheData.age_days = Math.floor((new Date() - generatedAt) / (1000 * 60 * 60 * 24));
        }

        res.json(cacheData);
    } catch (error) {
        console.error('Errore verifica cache:', error);
        res.status(500).json({
            error: 'Errore nella verifica della cache',
            cache_available: false
        });
    }
});


// LOOP check
setInterval(async () => {
	try {
		const corseInRiepilogo = await firestoreHelpers.getWhere('rides', 'status', '==', 'in_riepilogo');
		const now = new Date();
		const tempoMaxRiepilogoMs = 20 * 60 * 1000;
		
		for (const corsa of corseInRiepilogo) {
			const scadenza = new Date(corsa.endTime.toDate().getTime() + tempoMaxRiepilogoMs);
			
			if (now > scadenza) {
				await gestisciScadenzaCorsa(corsa.id);
				console.log(`Corsa ${corsa.id} completata automaticamente per scadenza.`);
			}
		}
	} catch (err) {
		console.error('Errore gestione corse scadute:', err);
	}
}, 30000);


app.listen(port, () => {
	console.log(`
███    ███  ██████  ██████  ██ ███████ ██   ██  █████  ██████  ███████
████  ████ ██    ██ ██   ██ ██ ██      ██   ██ ██   ██ ██   ██ ██
██ ████ ██ ██    ██ ██████  ██ ███████ ███████ ███████ ██████  █████
██  ██  ██ ██    ██ ██   ██ ██      ██ ██   ██ ██   ██ ██   ██ ██
██      ██  ██████  ██████  ██ ███████ ██   ██ ██   ██ ██   ██ ███████ `);
	console.log(`MobiShare is running on http://localhost:${port}`);
});