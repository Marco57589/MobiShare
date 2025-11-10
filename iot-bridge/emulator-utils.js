const admin = require('firebase-admin');
const path = require("path");
const fs = require("fs");
const axios = require("axios");

const HUE_EMULATOR_BASE_URL = 'http://localhost:8300/api';
let HUE_USERNAME = null;

async function registerHueUser() {
	try {
		const response = await axios.post(`${HUE_EMULATOR_BASE_URL}`, {
			devicetype: 'mqtt-server#mqtt'
		});
		
		if (response.data && Array.isArray(response.data)) {
			const result = response.data[0];
			if (result.success && result.success.username) {
				HUE_USERNAME = result.success.username;
				console.log(`[Hue Emulator] username registrato: ${HUE_USERNAME}`);
				return HUE_USERNAME;
			} else if (result.error && result.error.description) {
				console.error('[Hue Emulator] Errore registrazione Hue user:', result.error.description);
			}
		}
	} catch (err) {
		console.error('[Hue Emulator] Errore durante registrazione Hue user:', err.message);
	}
	return null;
}

async function generateVehicleLampJSON() {
	const filePath = path.join('hue-emulator', 'hue-emulator.json');
	const lights = {};
	
	try {
		const mezziSnap = await admin.firestore().collection('mezzi').get();
		const mezziIds = [];
		
		mezziSnap.forEach(doc => {
			const mezzoData = doc.data();
			const mezzoId = Number(mezzoData.id);
			mezziIds.push(mezzoId);
			
			lights[mezzoId] = {
				state: {
					on: true,
					bri: 254,
					hue: 4444 + mezzoId * 1000,
					sat: 254,
					xy: [0.0, 0.0],
					ct: 0,
					alert: "none",
					effect: "none",
					colormode: "hs",
					reachable: true
				},
				type: "Extended color light",
				name: `Vehicle ${mezzoId}`,
				modelid: "LCT001",
				swversion: "65003148",
				uniqueid: `00:17:88:01:00:d4:12:${8 + mezzoId}`,
				pointsymbol: {
					"1":"none","2":"none","3":"none","4":"none",
					"5":"none","6":"none","7":"none","8":"none"
				}
			};
		});
		
		const hueConfig = {
			lights,
			config: {
				name: "Philips hue",
				bridgeid: "000088FFFE00BBEE",
				ipaddress: "192.168.1.11:8300",
				linkbutton: false,
				dhcp: true,
				whitelist: {}
			},
			groups: {},
			scenes: {},
			schedules: {}
		};
		
		fs.writeFileSync(filePath, JSON.stringify(hueConfig, null, 2));
		console.log(`[Hue Emulator] File JSON generato con ${mezziIds.length} luci per ID: [${mezziIds.join(', ')}]: ${filePath}`);
		
	} catch (error) {
		console.error('[Hue Emulator] Errore nella generazione del JSON luci:', error);
	}
}

async function syncAllLights() {
	try {
		const mezziSnap = await admin.firestore().collection('mezzi').get();
		
		for (const doc of mezziSnap.docs) {
			const mezzoData = doc.data();
			const mezzoId = Number(mezzoData.id); // Usa l'ID numerico
			await updateMezzoLight(mezzoId, mezzoData.stato || 'Disponibile');
		}
		console.log('[Hue Emulator] Sincronizzazione completa completata');
	} catch (error) {
		console.error('[Hue Emulator] Errore nella sincronizzazione completa:', error);
	}
}

async function updateMezzoLight(mezzoId, stato) {
	if (!HUE_USERNAME) return;
	
	try {
		const lightId = Number(mezzoId);
		
		let on = false;
		let hue = 0;
		let sat = 0;
		
		switch (stato) {
			case 'sbloccato':
			case 'Disponibile':
				// Verde per mezzo sbloccato/disponibile
				on = true;
				hue = 25500; // Verde
				sat = 254;
				break;
			case 'bloccato':
			case 'Non disponibile':
				// Rosso per mezzo bloccato/non disponibile
				on = true;
				hue = 0; // Rosso
				sat = 254;
				break;
			case 'In uso':
				// Blu per mezzo in uso
				on = true;
				hue = 46920; // Blu
				sat = 254;
				break;
			default:
				on = false; // Spento
		}
		
		await axios.put(`${HUE_EMULATOR_BASE_URL}/${HUE_USERNAME}/lights/${lightId}/state`, {
			on,
			hue,
			sat,
			bri: on ? 254 : 0,
			alert: "none"
		});
		
		console.log(`[Hue Emulator] Luce ${lightId} (mezzo ${mezzoId}) aggiornata: ${stato}`);
		
	} catch (err) {
		console.error(`[Hue Emulator] Errore aggiornamento luce per mezzo ${mezzoId}:`, err.message);
	}
}

async function waitForEmulatorLink(timeoutMs = 60000, intervalMs = 5000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const registered = await registerHueUser();
		if (registered) return true;
		console.log('[Hue Emulator] Link button non premuto, nuovo controllo tra 5 secondi...\n (Premi il tasto di link sullo Hue Emulator.)');
		await new Promise(r => setTimeout(r, intervalMs));
	}
	return false;
}

async function syncVehicleAddRemove(changeType, mezzoId, mezzoData) {
	try {
		if (!global.aedesInstance) return;
		
		const message = {
			type: changeType, // 'added', 'removed', 'modified'
			mezzoId: Number(mezzoId),
			mezzoData: mezzoData,
			timestamp: new Date().toISOString(),
			source: 'firestore_sync'
		};
		
		global.aedesInstance.publish({
			topic: 'mobishare/mezzi/aggiornamenti',
			payload: JSON.stringify(message),
			qos: 1
		});
		
		console.log(`📤 MQTT: Pubblicato ${changeType} per mezzo ${mezzoId}`);
		
	} catch (error) {
		console.error(`Errore sync ${changeType} veicolo:`, error);
	}
}

function setupFirestoreSync() {	
	admin.firestore().collection('mezzi')
		.onSnapshot((snapshot) => {
			snapshot.docChanges().forEach((change) => {
				const docId = change.doc.id;
				const mezzoData = change.doc.data();
				const mezzoId = Number(mezzoData.id);
				
				switch (change.type) {
					case 'added':
						console.log(`➕ Nuovo mezzo aggiunto: ${mezzoId} (doc: ${docId})`);
						syncVehicleAddRemove('added', mezzoId, mezzoData);
						updateMezzoLight(mezzoId, mezzoData.stato || 'Disponibile');
						break;
					
					case 'removed':
						console.log(`➖ Mezzo rimosso: ${mezzoId} (doc: ${docId})`);
						syncVehicleAddRemove('removed', mezzoId, mezzoData);
						break;
					
					case 'modified':
						console.log(`✏️ Mezzo modificato: ${mezzoId} - Stato: ${mezzoData.stato}`);
						
						const statoMessage = {
							mezzoId: mezzoId,
							stato: mezzoData.stato || 'Disponibile',
							batteria: mezzoData.batteria || 100,
							timestamp: new Date().toISOString(),
							source: 'firestore_sync'
						};
						
						global.aedesInstance.publish({
							topic: 'mobishare/mezzi/stato',
							payload: JSON.stringify(statoMessage),
							qos: 1,
							retain: true
						});
						
						updateMezzoLight(mezzoId, mezzoData.stato);
						break;
				}
			});
		});
}

module.exports = {
	generateVehicleLampJSON,
	updateMezzoLight,
	waitForEmulatorLink,
	syncAllLights,
	setupFirestoreSync,
	HUE_USERNAME
};