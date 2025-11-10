const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mqtt = require('mqtt');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const MQTT_HOST = process.env.MQTT_HOST || 'localhost';
const MQTT_PORT = process.env.MQTT_PORT || 1883;

const vehicles = new Map();

const { updateMezzoLight } = require('./iot-bridge/emulator-utils');

const mqttClient = mqtt.connect(`mqtt://${MQTT_HOST}:${MQTT_PORT}`, {
	username: 'dashboard',
	password: process.env.MQTT_DASHBOARD_PASSWORD || 'dashboard123'
});

mqttClient.on('connect', () => {
	console.log('✅ Dashboard connessa al broker MQTT');
	
	mqttClient.subscribe([
		'mobishare/mezzi/stato',
		'mobishare/mezzi/batteria',
		'mobishare/mezzi/comando',
		'mobishare/mezzi/notifiche',
		'mobishare/mezzi/prenotazione',
		'mobishare/mezzi/risposta',
		'mobishare/mezzi/aggiornamenti',
		'mobishare/mezzi/lista_completa'
	], (err) => {
		if (err) console.error('Errore sottoscrizione:', err);
		else {
			requestCompleteList();
		}
	});
});

function requestCompleteList() {
	const request = {
		type: 'complete_list_request',
		timestamp: new Date().toISOString(),
		source: 'dashboard'
	};
	mqttClient.publish('system/request-vehicle-list', JSON.stringify(request));
}

mqttClient.on('message', (topic, message) => {
	console.log(`MQTT messaggio ricevuto su topic: ${topic}`);
	try {
		const data = JSON.parse(message.toString());
		
		switch (topic) {
			case 'mobishare/mezzi/stato':
				//console.log(`mobishare/mezzi/stato: Dettagli messaggio:`, data);
				updateVehicleState(data);
				break;
			
			case 'mobishare/mezzi/aggiornamenti':
				//console.log(`mobishare/mezzi/aggiornamenti:`, data);
				handleVehicleAddRemove(data);
				break;
			
			case 'mobishare/mezzi/lista_completa':
				//console.log(`mobishare/mezzi/lista_completa: Ricevuti ${data.count} veicoli`);
				handleCompleteVehicleList(data);
				break;
			case 'mobishare/mezzi/batteria':
				//console.log(`mobishare/mezzi/batteria: Dettagli messaggio:`, data);
				updateVehicleBattery(data);
				break;
			
			default:
				console.log(`Messaggio su ${topic}:`, data);
		}
	} catch (error) {
		console.error('Errore elaborazione messaggio:', error);
	}
});

function handleCompleteVehicleList(data) {
	//console.log(`🔄 Ricevuta lista completa con ${data.vehicles.length} veicoli`);
	vehicles.clear();
	
	data.vehicles.forEach(vehicle => {
		vehicles.set(vehicle.id, {
			id: vehicle.id,
			stato: vehicle.stato,
			batteria: vehicle.batteria,
			tipo: vehicle.tipo,
			isElettrico: vehicle.isElettrico,
			luce: { on: false, color: '#000000' },
			ultimoAggiornamento: new Date()
		});
		updateVehicleLight(vehicle.id, vehicle.stato);
	});
	
	io.emit('vehicle-update', Array.from(vehicles.values()));
}

async function updateVehicleState(data) {
	const { mezzoId, stato, batteria } = data;
	
	if (!vehicles.has(mezzoId)) {
		//console.log(`➕ Nuovo veicolo rilevato: ${mezzoId}`);
		vehicles.set(mezzoId, {
			id: mezzoId,
			stato: 'sconosciuto',
			batteria: batteria !== undefined ? batteria : null,
			luce: { on: false, color: '#000000' },
			ultimoAggiornamento: new Date()
		});
	}
	
	const vehicle = vehicles.get(mezzoId);
	const oldState = vehicle.stato;
	vehicle.stato = stato;
	vehicle.batteria = batteria !== undefined ? batteria : vehicle.batteria;
	vehicle.ultimoAggiornamento = new Date();
	
	updateVehicleLight(mezzoId, stato);
	
	updateMezzoLight(mezzoId, stato).catch(err => {
		console.error(`Errore aggiornamento Hue per mezzo ${mezzoId}:`, err.message);
	});
	
	io.emit('vehicle-update', Array.from(vehicles.values()));
	
	if (oldState !== stato) {
		console.log(`-Veicolo ${mezzoId} cambiato: ${oldState} → ${stato}`);
	}
}

async function updateVehicleBattery(data) {
	const { mezzoId, batteria, source } = data;
	
	console.log(`Aggiornamento batteria per mezzo ${mezzoId}: ${batteria}% (fonte: ${source || 'sconosciuta'})`);
	
	if (!vehicles.has(mezzoId)) {
		console.log(`➕ Nuovo veicolo rilevato via aggiornamento batteria: ${mezzoId}`);
		vehicles.set(mezzoId, {
			id: mezzoId,
			stato: 'sconosciuto',
			batteria: batteria,
			tipo: 'Mezzo',
			isElettrico: true,
			luce: { on: false, color: '#000000' },
			ultimoAggiornamento: new Date()
		});
	}
	
	const vehicle = vehicles.get(mezzoId);
	const vecchiaBatteria = vehicle.batteria;

	if(batteria < 25)
		vehicle.stato = 'Non disponibile';
	else if(vehicle.stato === 'Non disponibile' && batteria >= 25)
		vehicle.stato = 'Disponibile';

	vehicle.batteria = batteria;
	vehicle.ultimoAggiornamento = new Date();
	
	// Aggiorna il colore della luce in base alla batteria se il mezzo è elettrico
	if (vehicle.isElettrico) {
		updateBatteryLight(mezzoId, batteria);
	}
	
	io.emit('vehicle-update', Array.from(vehicles.values()));
	
	if (vecchiaBatteria !== batteria) {
		console.log(`-Batteria mezzo ${mezzoId} aggiornata: ${vecchiaBatteria}% → ${batteria}%`);
	}
	
}

function updateBatteryLight(mezzoId, batteria) {
	if (!vehicles.has(mezzoId)) return;
	
	const vehicle = vehicles.get(mezzoId);
	let color = '#000000';
	let on = true;
	
	// Colori in base al livello della batteria
	if (batteria >= 75) {
		color = '#00ff00'; // Verde - Batteria alta
	} else if (batteria >= 25) {
		color = '#ffff00'; // Giallo - Batteria media
	} else {
		color = '#ff0000'; // Rosso - Batteria bassa
	}
	
	vehicle.luce = { on, color };
}

function handleVehicleAddRemove(data) {
	const { type, mezzoId, mezzoData } = data;
	
	switch (type) {
		case 'added':
			if (!vehicles.has(mezzoId)) {
				console.log(`➕ Aggiunto nuovo veicolo via MQTT: ${mezzoId}`);
				vehicles.set(mezzoId, {
					id: mezzoId,
					stato: mezzoData.stato || 'Disponibile',
					batteria: mezzoData.batteria || null,
					luce: { on: false, color: '#000000' },
					ultimoAggiornamento: new Date()
				});
				
				updateVehicleLight(mezzoId, mezzoData.stato || 'Disponibile');
				io.emit('vehicle-update', Array.from(vehicles.values()));
			}
			break;
		
		case 'removed':
			if (vehicles.has(mezzoId)) {
				console.log(`➖ Rimosso veicolo via MQTT: ${mezzoId}`);
				vehicles.delete(mezzoId);
				io.emit('vehicle-update', Array.from(vehicles.values()));
			}
			break;
	}
}

function updateVehicleLight(mezzoId, stato) {
	if (!vehicles.has(mezzoId)) return;
	
	const vehicle = vehicles.get(mezzoId);
	let color = '#000000';
	let on = true;
	
	switch (stato) {
		case 'Disponibile':
		case 'sbloccato':
			color = '#00ff00'; // Verde
			break;
		case 'Non disponibile':
		case 'bloccato':
			color = '#ff0000'; // Rosso
			break;
		case 'In uso':
			color = '#0000ff'; // Blu
			break;
		default:
			on = false;
			color = '#666666';
	}
	
	vehicle.luce = { on, color };
}

app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public-emulator')));
app.set('views', path.join(__dirname, 'views-emulator'));

app.get('/', (req, res) => {
	res.render('dashboard', {
		vehicles: Array.from(vehicles.values())
	});
});

app.post('/mezzo/:id/blocca', (req, res) => {
	const mezzoId = req.params.id;
	const vehicle = vehicles.get(Number(mezzoId));
	
	if (!vehicle) {
		return res.status(404).send('Mezzo non trovato');
	}
	if (vehicle.stato !== 'Disponibile') {
		return res.status(400).send('Il mezzo non è nello stato Disponibile');
	}
	
	const comando = {
		action: 'blocca',
		mezzoId: Number(mezzoId),
		timestamp: new Date().toISOString()
	};
	mqttClient.publish('mobishare/mezzi/comando', JSON.stringify(comando));
	return res.send('Comando blocco inviato');
});

app.post('/mezzo/:id/sblocca', (req, res) => {
	const mezzoId = req.params.id;
	const vehicle = vehicles.get(Number(mezzoId));
	
	if (!vehicle) {
		return res.status(404).send('Mezzo non trovato');
	}
	if (vehicle.stato !== 'Non disponibile') {
		return res.status(400).send('Il mezzo non è nello stato Non disponibile');
	}
	
	const comando = {
		action: 'sblocca',
		mezzoId: Number(mezzoId),
		timestamp: new Date().toISOString()
	};
	mqttClient.publish('mobishare/mezzi/comando', JSON.stringify(comando));
	return res.send('Comando sblocco inviato');
});

io.on('connection', (socket) => {
	console.log('🌐 Client web connesso');
	
	socket.emit('vehicle-update', Array.from(vehicles.values()));
	
	socket.on('disconnect', () => {
		console.log('🌐 Client web disconnesso');
	});
});

const PORT = process.env.EMULATOR_PORT || 3001;
server.listen(PORT, () => {
	console.log(`
███╗   ███╗ ██████╗ ██████╗ ██╗    ███████╗███╗   ███╗██╗   ██╗██╗      █████╗ ████████╗ ██████╗ ██████╗
████╗ ████║██╔═══██╗██╔══██╗██║    ██╔════╝████╗ ████║██║   ██║██║     ██╔══██╗╚══██╔══╝██╔═══██╗██╔══██╗
██╔████╔██║██║   ██║██████╔╝██║    █████╗  ██╔████╔██║██║   ██║██║     ███████║   ██║   ██║   ██║██████╔╝
██║╚██╔╝██║██║   ██║██╔══██╗██║    ██╔══╝  ██║╚██╔╝██║██║   ██║██║     ██╔══██║   ██║   ██║   ██║██╔══██╗
██║ ╚═╝ ██║╚██████╔╝██████╗ ██║    ███████╗██║ ╚═╝ ██║╚██████╔╝███████╗██║  ██║   ██║   ╚██████╔╝██║  ██║
╚═╝     ╚═╝ ╚═════╝ ╚═╝ ╚═╝ ╚═╝    ╚══════╝╚═╝     ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝
	`);
	console.log(`Mobishare Web-Emulator running on http://localhost:${PORT}`);
});