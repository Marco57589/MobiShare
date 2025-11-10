class FaceRecognition {
	constructor(videoId, canvasId, instructionsId = null) {
		this.video = document.getElementById(videoId);
		this.canvas = document.getElementById(canvasId);
		this.context = this.canvas.getContext('2d');
		this.stream = null;
		this.instructionsId = instructionsId;
	}
	
	async startCamera() {
		try {
			this.stream = await navigator.mediaDevices.getUserMedia({
				video: { width: 400, height: 300 }
			});
			this.video.srcObject = this.stream;
			this.video.classList.remove('d-none');
			
			if (this.instructionsId) {
				document.getElementById(this.instructionsId).classList.add('d-none');
			}
			
			return true;
		} catch (error) {
			console.error('Errore accesso camera:', error);
			throw new Error('Impossibile accedere alla camera. Controlla i permessi.');
		}
	}
	
	capturePhoto() {
		this.context.drawImage(this.video, 0, 0, 400, 300);
		this.canvas.classList.remove('d-none');
		this.video.classList.add('d-none');
		
		return new Promise((resolve) => {
			this.canvas.toBlob(resolve, 'image/jpeg', 0.8);
		});
	}
	
	async registerFace() {
		const blob = await this.capturePhoto();
		console.log('Blob size:', blob.size);
		
		const formData = new FormData();
		formData.append('image', blob, 'face.jpg');
		
		const response = await fetch('/api/face-recognition/register', {
			method: 'POST',
			body: formData
		});
		
		const result = await response.json();
		
		if (!response.ok) {
			throw new Error(result.detail || 'Errore nella registrazione');
		}
		
		return result;
	}
	
	async verifyFace() {
		const blob = await this.capturePhoto();
		
		const formData = new FormData();
		formData.append('image', blob, 'verify_face.jpg');
		
		const response = await fetch('/api/face-recognition/verify', {
			method: 'POST',
			body: formData
		});
		
		const result = await response.json();
		
		if (!response.ok) {
			throw new Error(result.detail || 'Errore nella verifica');
		}
		
		return result;
	}
	
	retryCapture() {
		this.canvas.classList.add('d-none');
		this.video.classList.remove('d-none');
	}
	
	stopCamera() {
		if (this.stream) {
			this.stream.getTracks().forEach(track => track.stop());
		}
		this.video.srcObject = null;
	}
	
	reset() {
		this.stopCamera();
		
		this.video.classList.add('d-none');
		this.canvas.classList.add('d-none');
		
		const context = this.canvas.getContext('2d');
		context.clearRect(0, 0, this.canvas.width, this.canvas.height);
		
		if (this.instructionsId) {
			document.getElementById(this.instructionsId).classList.remove('d-none');
		}
		
		const startBtn = document.getElementById('startFaceVerification');
		const captureBtn = document.getElementById('captureFace');
		const retryBtn = document.getElementById('retryFace');
		
		if (startBtn) startBtn.classList.remove('d-none');
		if (captureBtn) captureBtn.classList.add('d-none');
		if (retryBtn) retryBtn.classList.add('d-none');
	}
}