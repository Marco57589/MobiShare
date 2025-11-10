const admin = require('firebase-admin');

const SYSTEM_ACCOUNTS = {
	dashboard: {
		username: 'dashboard',
		password: process.env.MQTT_DASHBOARD_PASSWORD || 'dashboard123',
		userId: 'system-dashboard',
		ruolo: 'server'
	},
	emulator: {
		username: 'emulator',
		password: process.env.MQTT_EMULATOR_PASSWORD || 'emulator123',
		userId: 'system-emulator',
		ruolo: 'server'
	},
	arduino: {
		username: 'arduino',
		password: process.env.MQTT_ARDUINO_PASSWORD || 'arduino123',
		userId: 'system-arduino',
		ruolo: 'device'
	}
};

async function verifyMqttAuth(username, password) {
	try {
		for (const [key, account] of Object.entries(SYSTEM_ACCOUNTS)) {
			if (username === account.username && password === account.password) {
				console.log(`✅ System account authenticated: ${key}`);
				return {
					success: true,
					uid: account.userId,
					ruolo: account.ruolo
				};
			}
		}
		
		if (password.startsWith('eyJ')) {
			const decodedToken = await admin.auth().verifyIdToken(password);
			
			const userDoc = await admin.firestore().collection('users').doc(decodedToken.uid).get();
			let ruolo = 'utente'; // default
			
			if (userDoc.exists) {
				ruolo = userDoc.data().ruolo || 'utente';
			}
			
			console.log(`✅ MQTT Auth: User ${decodedToken.uid}, Ruolo: ${ruolo}`);
			
			return {
				success: true,
				uid: decodedToken.uid,
				ruolo: ruolo
			};
		} else {
			return { success: false, error: 'Invalid credentials format' };
		}
		
	} catch (error) {
		console.error('❌ MQTT Auth error:', error);
		return { success: false, error: error.message };
	}
}

module.exports = { verifyMqttAuth };