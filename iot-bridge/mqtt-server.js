const admin = require('firebase-admin');
const dotenv = require('dotenv');

const { verifyMqttAuth } = require('./mqtt-auth');
const { updateVehicleStatus, verificaPrenotazione, updateVehicleBattery } = require('./firestore-utils');
const { generateVehicleLampJSON, updateMezzoLight, waitForEmulatorLink, syncAllLights, setupFirestoreSync } = require('./emulator-utils');

dotenv.config();

try {
	admin.app();
	console.log('Using existing Firebase Admin instance');
} catch {
	const serviceAccount = require('../serviceAccountKey.json');
	admin.initializeApp({
		credential: admin.credential.cert(serviceAccount),
		databaseURL: process.env.FIREBASE_DATABASE_URL
	});
	console.log('Firebase Admin initialized in MQTT server');
}

const aedes = require('aedes')();
const net = require('net');
const http = require('http');
const websocketStream = require('websocket-stream');
let HUE_USERNAME = null;

const mqttPort = process.env.MQTT_PORT || 1883;
const wsPort = process.env.MQTT_WS_PORT || 9001;

const tcpServer = net.createServer(aedes.handle);
const httpServer = http.createServer();

async function sendCompleteVehicleList() {
	try {
		const mezziSnap = await admin.firestore().collection('mezzi').get();
		const vehicles = [];
		
		mezziSnap.forEach(doc => {
			const mezzo = doc.data();
			vehicles.push({
				id: Number(mezzo.id), // Usa l'ID numerico
				stato: mezzo.stato || 'Disponibile',
				batteria: mezzo.batteria || null,
				tipo: mezzo.tipo || 'Mezzo',
				isElettrico: mezzo.isElettrico || false
			});
		});
		
		const completeListMessage = {
			type: 'complete_list',
			vehicles: vehicles,
			count: vehicles.length,
			timestamp: new Date().toISOString(),
			source: 'mqtt_server'
		};
		
		aedes.publish({
			topic: 'mobishare/mezzi/lista_completa',
			payload: JSON.stringify(completeListMessage)
		});
		
		console.log(`📤 Registrati sull'emulatore web: ${vehicles.length} veicoli!`);
		
	} catch (error) {
		console.error('❌ Error sending complete vehicle list:', error);
	}
}

async function startMqttServer() {
	console.log('Starting MQTT server...');
	
	try {
		const username = await waitForEmulatorLink(30000); // Timeout 30 secondi, altrimenti solo web
		if (username) {
			HUE_USERNAME = username;
			console.log('✅ Hue Emulator (java) connesso');
			
			await generateVehicleLampJSON();
			setupFirestoreSync();
			await syncAllLights();
		} else {
			setupFirestoreSync();
			console.log('⚠️  Hue Emulator not available');
		}
	} catch (error) {
		console.log('⚠️  Hue Emulator initialization failed', error.message);
	}
	
	global.aedesInstance = aedes;
	
	tcpServer.listen(mqttPort, () => {
		console.log(`🚀--> MQTT TCP server listening on port ${mqttPort}`);
	});
	
	websocketStream.createServer({server: httpServer}, aedes.handle);
	httpServer.listen(wsPort, () => {
		console.log(`🚀--> MQTT WebSocket server listening on port ${wsPort}`);
	});
	
	return {
		tcpServer,
		wsServer: httpServer,
		aedesBroker: aedes
	};
}

aedes.on('client', (client) => {
	console.log('Nuovo client connesso:', {
		id: client.id,
		userId: client.userId || 'non autenticato',
		ruolo: client.ruolo || 'non definito',
		ip: client.conn.remoteAddress
	});
});

aedes.authenticate = async (client, username, password, callback) => {
	try {
		if (!username || !password) {
			console.log('Missing credentials');
			return callback(null, false);
		}
		
		const { success, uid, ruolo } = await verifyMqttAuth(username, password.toString());
		if (success) {
			console.log(`✅ Autenticato l'utente: ${username} (UID: ${uid}, ruolo: ${ruolo})`);
			client.userId = uid;
			client.ruolo = ruolo;
			return callback(null, true);
		} else {
			console.log(`❌ Autenticazione fallita per l'utente: ${username}`);
			return callback(null, false);
		}
	} catch (err) {
		console.error('Authentication error:', err);
		return callback(err, false);
	}
};

aedes.authorizePublish = (client, packet, callback) => {
	if (!client.userId) {
		return callback(new Error('Unauthorized'));
	}
	
	const topic = packet.topic;
	
	if (client.ruolo === 'server' || client.ruolo === 'device') {
		return callback(null);
	}
	
	if (['mobishare/test', 'mobishare/mezzi/comando'].includes(topic)) {
		if (client.ruolo === 'gestore') {
			return callback(null);
		}
		return callback(new Error('Solo i gestori possono pubblicare su questo topic'));
	}
	
	if (topic === 'mobishare/mezzi/prenotazione') {
		return callback(null);
	}
	
	callback(new Error('Unauthorized topic'));
};

aedes.authorizeSubscribe = (client, sub, callback) => {
	if (!client.userId) {
		return callback(new Error('Unauthorized'));
	}
	
	const topic = sub.topic;
	
	if (client.ruolo === 'server' || client.ruolo === 'device') {
		return callback(null, sub);
	}
	
	if (['mobishare/mezzi/stato', 'mobishare/mezzi/notifiche', 'mobishare/mezzi/risposta', 'mobishare/mezzi/batteria'].includes(topic)) {
		return callback(null, sub);
	}
	
	if (['mobishare/mezzi/comando'].includes(topic)) {
		if (client.ruolo === 'gestore') {
			return callback(null, sub);
		}
		return callback(new Error('Unauthorized subscription'));
	}
	
	return callback(new Error('Unauthorized subscription'));
};

aedes.on('publish', async (packet, client) => {
	if (!client) return;
	
	try {
		const topic = packet.topic;
		const message = packet.payload.toString();
		
		console.log(`🔍 MQTT Message [${topic}]:`, message.substring(0, 100) + '...');
		
		if (topic === 'system/request-vehicle-list') {
			console.log('🎯 Richiesta lista completa veicoli');
			await sendCompleteVehicleList();
			return;
		}
		
		if (topic === 'mobishare/mezzi/comando') {
			try {
				const comando = JSON.parse(message);
				console.log(`🎮 Comando per mezzo ${comando.mezzoId}: ${comando.action}`);
				
				let nuovoStato;
				if (comando.action === 'blocca') {
					nuovoStato = 'Non disponibile';
				} else if (comando.action === 'sblocca') {
					nuovoStato = 'Disponibile';
				} else if (comando.action === 'in_uso') {
					nuovoStato = 'In uso';
				} else if(comando.action === 'batteria') {
					await updateVehicleBattery(comando.mezzoId, comando.batteria);

					const statoMessage = {
						mezzoId: comando.mezzoId,
						batteria: comando.batteria,
						userId: client.userId,
						timestamp: new Date().toISOString(),
						source: 'battery_update'
					};

					console.log(`📤 PUBBLICANDO su mobishare/mezzi/batteria:`, statoMessage);
					
					aedes.publish({
						topic: 'mobishare/mezzi/batteria',
						payload: JSON.stringify(statoMessage),
						qos: 1,
						retain: true
					});

					console.log(`✅ Messaggio batteria pubblicato per mezzo ${comando.mezzoId}`);
				}
				
				if (nuovoStato) {
					await updateVehicleStatus(comando.mezzoId, nuovoStato);
					
					if (HUE_USERNAME) {
						await updateMezzoLight(comando.mezzoId, nuovoStato);
					}
					
					const statoMessage = {
						mezzoId: comando.mezzoId,
						stato: nuovoStato,
						timestamp: new Date().toISOString(),
						userId: client.userId,
						source: 'command'
					};
					
					console.log(`📤 PUBBLICANDO su mobishare/mezzi/stato:`, statoMessage);
					
					aedes.publish({
						topic: 'mobishare/mezzi/stato',
						payload: JSON.stringify(statoMessage),
						qos: 1,
						retain: true
					});
					
					console.log(`✅ Messaggio stato pubblicato per mezzo ${comando.mezzoId}`);
				}
				
			} catch (err) {
				console.error('Errore comando mezzo:', err.message);
			}
		}
		
		if (topic === 'mobishare/mezzi/prenotazione') {
			try {
				const prenotazione = JSON.parse(message);
				console.log(`Prenotato mezzo ${prenotazione.mezzoId} da ${prenotazione.userId}`);
				
				const canUnlock = await verificaPrenotazione(prenotazione.userId, prenotazione.mezzoId);
				
				const response = {
					mezzoId: prenotazione.mezzoId,
					userId: prenotazione.userId,
					autorizzato: canUnlock,
					timestamp: new Date().toISOString()
				};
				
				aedes.publish({
					topic: 'mobishare/mezzi/risposta',
					payload: JSON.stringify(response)
				});
				
				if (canUnlock) {
					// Sblocca il mezzo e aggiorna la luce
					await updateVehicleStatus(prenotazione.mezzoId, 'In uso');
					if (HUE_USERNAME) {
						await updateMezzoLight(prenotazione.mezzoId, 'In uso');
					}
				}
				
			} catch (err) {
				console.error('❌Errore prenotazione:', err.message);
			}
		}	
	} catch (error) {
		console.error('❌Error processing message:', error);
	}
});

aedes.on('clientError', (client, err) => {
	console.log(`❌ Client error (${client?.id || 'unknown'}):`, err.message);
});

aedes.on('connectionError', (client, err) => {
	console.log(`❌ Connection error (${client?.id || 'unknown'}):`, err.message);
});

aedes.on('clientDisconnect', (client) => {
	console.log('📤 Client disconnesso:', {
		id: client.id,
		userId: client.userId || 'non autenticato',
		ruolo: client.ruolo || 'non definito'
	});
});

module.exports = {
	startMqttServer
};