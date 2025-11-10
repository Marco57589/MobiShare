document.addEventListener('DOMContentLoaded', () => {
  if (window.modalCorsaAttiva === 'true') {
    const modal = new bootstrap.Modal(document.getElementById('modalTerminaCorsa'));
    modal.show();

    // ⏱ Timer parte sempre da 00:00
    const durataSpan = document.getElementById('durata-corsa');
    if (durataSpan) {
      let seconds = 0;
      function updateTimer() {
        const min = String(Math.floor(seconds / 60)).padStart(2, '0');
        const sec = String(seconds % 60).padStart(2, '0');
        durataSpan.textContent = `${min}:${sec}`;
        seconds++;
      }

      updateTimer();
      setInterval(updateTimer, 1000);
      
const form = document.querySelector('form[action="/termina-corsa"]');
if (form) {
  form.addEventListener('submit', () => {
    const durata = durataSpan.textContent;
    const [min, sec] = durata.split(':').map(n => parseInt(n));
    const durataTotale = Math.ceil((min * 60 + sec) / 60); // minuti arrotondati
    const hiddenInput = document.getElementById('durataClient');
    if (hiddenInput) hiddenInput.value = durataTotale;
  });
}
    }
  }

  // Modal riepilogo dopo la fine corsa
  if (modalRiepilogo == "true") {
      var riepilogoModal = new bootstrap.Modal(document.getElementById('modalRiepilogo'));
      riepilogoModal.show();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('dannoAltroToggle');
  const input = document.getElementById('dannoAltroInput');
  if (toggle && input) {
    toggle.addEventListener('change', () => {
      input.style.display = toggle.checked ? 'block' : 'none';
    });
  }
});