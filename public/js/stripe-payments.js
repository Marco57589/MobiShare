class StripePaymentManager {
	constructor(stripePublishableKey) {
		this.stripe = Stripe(stripePublishableKey);
		this.card = null;
		this.elements = null;
		this.paymentVerified = false;
		this.cardValid = false;
		this.currentAmount = 0;
		this.paymentCallback = null;
		
		this.initializeStripe();
		this.initializeEventListeners();
	}
	
	initializeStripe() {
		this.elements = this.stripe.elements();
		
		const style = {
			base: {
				color: '#32325d',
				fontFamily: '"Inter", sans-serif',
				fontSize: '16px',
				'::placeholder': {
					color: '#aab7c4'
				}
			},
			invalid: {
				color: '#fa755a',
				iconColor: '#fa755a'
			}
		};
		
		this.card = this.elements.create('card', { style });
	}
	
	initializeEventListeners() {
		document.getElementById('stripePaymentModal')?.addEventListener('shown.bs.modal', () => {
			this.mountCardElement();
		});
		
		document.getElementById('stripePaymentModal')?.addEventListener('hidden.bs.modal', () => {
			this.unmountCardElement();
			this.resetPaymentForm();
		});
		
		document.getElementById('stripeAmountInput')?.addEventListener('input', (e) => {
			this.updateAmountDisplay(e.target.value);
		});
		
		document.getElementById('stripePaymentForm')?.addEventListener('submit', (e) => {
			e.preventDefault();
			this.handlePaymentSubmit();
		});
		
		document.getElementById('stripeSecurityModal')?.addEventListener('hidden.bs.modal', () => {
			this.resetSecurityModal();
		});
		
		this.initializeSecurityListeners();
	}
	
	initializeSecurityListeners() {
		document.querySelectorAll('input[name="verificationMethod"]').forEach(radio => {
			radio.addEventListener('change', (e) => {
				this.handleVerificationMethodChange(e.target.value);
			});
		});
		
		document.getElementById('verifyPasswordBtn')?.addEventListener('click', () => {
			this.verifyPassword();
		});
		
		document.getElementById('proceedPaymentBtn')?.addEventListener('click', () => {
			this.executePaymentAfterVerification();
		});
	}
	
	mountCardElement() {
		if (this.card && !this.card._element) {
			this.card.mount('#stripeCardElement');
			
			this.card.on('change', (event) => {
				this.handleCardChange(event);
			});
		}
	}
	
	unmountCardElement() {
		if (this.card && this.card._element) {
			this.card.unmount();
		}
	}
	
	handleCardChange(event) {
		const displayError = document.getElementById('stripeCardErrors');
		const submitBtn = document.getElementById('stripeSubmitButton');
		
		if (event.error) {
			displayError.textContent = event.error.message;
			this.cardValid = false;
			this.toggleSubmitButton(false);
		} else {
			displayError.textContent = '';
			this.cardValid = event.complete;
			this.toggleSubmitButton(event.complete);
		}
	}
	
	toggleSubmitButton(enabled) {
		const submitBtn = document.getElementById('stripeSubmitButton');
		if (!submitBtn) return;
		
		submitBtn.disabled = !enabled;
		if (enabled) {
			submitBtn.classList.remove('btn-secondary');
			submitBtn.classList.add('btn-success');
		} else {
			submitBtn.classList.add('btn-secondary');
			submitBtn.classList.remove('btn-success');
		}
	}
	
	updateAmountDisplay(amount) {
		const display = document.getElementById('stripeAmountDisplay');
		if (display) {
			display.textContent = parseFloat(amount || 0).toFixed(2);
		}
	}
	
	async handlePaymentSubmit() {
		if (!this.cardValid) {
			this.showCardError('Completa i dati della carta prima di procedere');
			return;
		}
		
		const amount = parseFloat(document.getElementById('stripeAmountInput').value);
		if (!amount || amount <= 0) {
			this.showCardError('Importo non valido');
			return;
		}
		
		this.currentAmount = amount;
		
		const submitBtn = document.getElementById('stripeSubmitButton');
		if (submitBtn) {
			submitBtn.disabled = true;
			submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status"></span> Verifica...';
		}
		
		try {
			const { error, paymentMethod } = await this.stripe.createPaymentMethod({
				type: 'card',
				card: this.card,
			});
			
			if (error) {
				this.showCardError(error.message);
				this.enablePaymentButtons();
				return;
			}
			
			this.openSecurityModal(amount);
			
			if (submitBtn) {
				submitBtn.disabled = false;
				submitBtn.textContent = 'Paga € ' + amount.toFixed(2);
			}
			
		} catch (error) {
			console.error('Errore:', error);
			this.showCardError('Errore durante la verifica della carta');
			this.enablePaymentButtons();
		}
	}
	
	openSecurityModal(amount) {
		document.getElementById('securityAmountDisplay').textContent = `€ ${amount.toFixed(2)}`;
		const securityModal = new bootstrap.Modal(document.getElementById('stripeSecurityModal'));
		securityModal.show();
	}
	
	async verifyPassword() {
		const password = document.getElementById('securityPassword').value;
		const verifyBtn = document.getElementById('verifyPasswordBtn');
		
		if (!password) {
			this.showVerificationResult('Inserisci la password', 'danger');
			return;
		}
		
		verifyBtn.disabled = true;
		verifyBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status"></span> Verifica in corso...';
		
		try {
			const response = await fetch('/api/verify-password', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ password })
			});
			
			const result = await response.json();
			
			if (result.success) {
				this.showVerificationResult('Password verificata con successo!', 'success');
				this.enablePaymentProceed();
			} else {
				this.showVerificationResult(result.error || 'Password non valida', 'danger');
			}
		} catch (error) {
			this.showVerificationResult('Errore durante la verifica', 'danger');
		} finally {
			verifyBtn.disabled = false;
			verifyBtn.textContent = 'Verifica Password';
		}
	}
	
	enablePaymentProceed() {
		this.paymentVerified = true;
		const proceedBtn = document.getElementById('proceedPaymentBtn');
		if (proceedBtn) {
			proceedBtn.classList.remove('d-none');
			proceedBtn.disabled = false;
		}
	}
	
	async executePaymentAfterVerification() {
		const submitBtn = document.getElementById('stripeSubmitButton');
		const proceedBtn = document.getElementById('proceedPaymentBtn');
		
		if (submitBtn) {
			submitBtn.disabled = true;
			submitBtn.classList.add('btn-secondary');
			submitBtn.classList.remove('btn-success');
		}
		
		if (proceedBtn) {
			proceedBtn.disabled = true;
			proceedBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status"></span> Elaborazione...';
		}
		
		try {
			// Crea Payment Intent
			const response = await fetch('/create-payment-intent', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ amount: this.currentAmount })
			});
			
			if (!response.ok) throw new Error('Errore nella creazione del pagamento');
			
			const { clientSecret, paymentIntentId } = await response.json();
			
			const { error, paymentIntent } = await this.stripe.confirmCardPayment(clientSecret, {
				payment_method: { card: this.card }
			});
			
			if (error) {
				this.showCardError(error.message);
				this.enablePaymentButtons();
			} else if (paymentIntent.status === 'succeeded') {
				await this.confirmPaymentOnServer(this.currentAmount, paymentIntentId);
			}
		} catch (error) {
			console.error('Errore:', error);
			this.showVerificationResult('Errore durante il pagamento. Riprova.', 'danger');
			this.enablePaymentButtons();
		}
	}
	
	enablePaymentButtons() {
		const submitBtn = document.getElementById('stripeSubmitButton');
		const proceedBtn = document.getElementById('proceedPaymentBtn');
		
		if (submitBtn) {
			submitBtn.disabled = false;
			submitBtn.classList.remove('btn-secondary');
			submitBtn.classList.add('btn-success');
		}
		
		if (proceedBtn) {
			proceedBtn.disabled = false;
			proceedBtn.textContent = 'Procedi con il Pagamento';
		}
	}
	
	async confirmPaymentOnServer(amount, paymentIntentId) {
		const response = await fetch('/conferma-ricarica-stripe', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ amount, paymentIntentId })
		});
		
		if (response.ok) {
			const result = await response.json();
			this.closeModalsAndRedirect(result.message);
		} else {
			throw new Error('Errore nella conferma del pagamento');
		}
	}
	
	closeModalsAndRedirect(successMessage) {
		const securityModal = bootstrap.Modal.getInstance(document.getElementById('stripeSecurityModal'));
		const paymentModal = bootstrap.Modal.getInstance(document.getElementById('stripePaymentModal'));
		
		if (securityModal) securityModal.hide();
		if (paymentModal) paymentModal.hide();
		
		const url = new URL(window.location.href);
		url.searchParams.set('success', encodeURIComponent(successMessage));
		
		window.location.href = url.toString();
	}
	
	showCardError(message) {
		const errorElement = document.getElementById('stripeCardErrors');
		if (errorElement) errorElement.textContent = message;
	}
	
	showVerificationResult(message, type) {
		const resultDiv = document.getElementById('verificationResult');
		if (resultDiv) {
			resultDiv.className = `alert alert-${type} mt-3`;
			resultDiv.textContent = message;
			resultDiv.classList.remove('d-none');
		}
	}
	
	resetPaymentForm() {
		this.cardValid = false;
		this.toggleSubmitButton(false);
		this.showCardError('');
		
		const submitBtn = document.getElementById('stripeSubmitButton');
		if (submitBtn) {
			submitBtn.disabled = false;
			const buttonText = document.getElementById('stripeButtonText');
			const spinner = document.getElementById('stripeSpinner');
			if (buttonText) buttonText.textContent = 'Paga € ' + (document.getElementById('stripeAmountDisplay')?.textContent || '0.00');
			if (spinner) spinner.classList.add('d-none');
		}
		
		this.paymentVerified = false;
	}
	
	resetSecurityModal() {
		this.paymentVerified = false;
		
		const proceedBtn = document.getElementById('proceedPaymentBtn');
		if (proceedBtn) {
			proceedBtn.classList.add('d-none');
			proceedBtn.disabled = true;
		}
		
		document.getElementById('verificationResult')?.classList.add('d-none');
		document.getElementById('securityPassword').value = '';
		
		if (window.faceVerifier) {
			window.faceVerifier.reset();
		}
	}
	
	handleVerificationMethodChange(method) {
		document.getElementById('passwordSection')?.classList.toggle('d-none', method !== 'password');
		document.getElementById('faceSection')?.classList.toggle('d-none', method !== 'face');
		this.resetSecurityModal();
	}
	
	initializePayment(minAmount = 0.01, maxAmount = 100, defaultAmount = 5.00, infoMessage = '') {
		const amountInput = document.getElementById('stripeAmountInput');
		const helpText = document.getElementById('amountHelpText');
		const infoAlert = document.getElementById('paymentInfoAlert');
		
		if (amountInput) {
			amountInput.min = minAmount;
			amountInput.max = maxAmount;
			amountInput.value = defaultAmount;
			this.updateAmountDisplay(defaultAmount);
		}
		
		if (helpText) {
			helpText.textContent = `Importo minimo: € ${minAmount.toFixed(2)} | Massimo: € ${maxAmount.toFixed(2)}`;
		}
		
		if (infoAlert && infoMessage) {
			infoAlert.innerHTML = `<span class="material-icons me-2">info</span>${infoMessage}`;
			infoAlert.classList.remove('d-none');
		} else if (infoAlert) {
			infoAlert.classList.add('d-none');
		}
	}
}

let stripePaymentManager;

function initializeStripePayment(stripePublishableKey) {
	if (!stripePaymentManager) {
		stripePaymentManager = new StripePaymentManager(stripePublishableKey);
	}
	
	window.stripePaymentManager = stripePaymentManager;
	
	return stripePaymentManager;
}