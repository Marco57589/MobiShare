document.addEventListener('DOMContentLoaded', () => {
    const title = document.getElementById('vehicleModalLabel');
    const body = document.getElementById('vehicleModalBody');
    const button = document.getElementById('vehicleModalBtn');
  
    document.querySelectorAll('.card[data-bs-toggle="modal"]').forEach(card => {
      card.addEventListener('click', () => {
        title.textContent = card.getAttribute('data-title');
        body.textContent = card.getAttribute('data-description');
      });
    });
  });