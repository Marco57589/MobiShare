class FaceRegistration {
	constructor() {
		this.faceRecognition = new FaceRecognition('video', 'canvas', 'instructions');
	}
	
	async startCamera() {
		try {
			await this.faceRecognition.startCamera();
			document.getElementById('instructions').classList.add('d-none');
			document.getElementById('startCamera').classList.add('d-none');
			document.getElementById('capture').classList.remove('d-none');
		} catch (error) {
			console.error('Errore accesso camera:', error);
			alert(error.message);
		}
	}
	
	async capturePhoto() {
		try {
			await this.faceRecognition.registerFace();
			location.reload();
		} catch (error) {
			console.error('Errore registrazione:', error);
			alert('Errore: ' + error.message);
			this.retryCapture();
		}
	}
	
	retryCapture() {
		this.faceRecognition.retryCapture();
		document.getElementById('capture').classList.remove('d-none');
		document.getElementById('retry').classList.add('d-none');
	}
	
	stopCamera() {
		this.faceRecognition.stopCamera();
	}
}

const faceReg = new FaceRegistration();

document.getElementById('startCamera').addEventListener('click', () => {
	faceReg.startCamera();
});

document.getElementById('capture').addEventListener('click', () => {
	faceReg.capturePhoto();
});

document.getElementById('retry').addEventListener('click', () => {
	faceReg.retryCapture();
});

document.getElementById('faceRegistrationModal').addEventListener('hidden.bs.modal', () => {
	faceReg.stopCamera();
	faceReg.retryCapture();
	document.getElementById('instructions').classList.remove('d-none');
	document.getElementById('startCamera').classList.remove('d-none');
});
