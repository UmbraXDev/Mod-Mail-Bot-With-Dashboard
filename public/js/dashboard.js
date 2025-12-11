document.addEventListener('DOMContentLoaded', function() {
  console.log('Dashboard loaded');
  
  const statCards = document.querySelectorAll('.stat-card');
  statCards.forEach(card => {
    card.addEventListener('mouseenter', function() {
      this.style.transform = 'translateY(-5px)';
    });
    card.addEventListener('mouseleave', function() {
      this.style.transform = 'translateY(0)';
    });
  });
});

function closeTicket(ticketId, event) {
  if (event) event.preventDefault();
  if (!confirm('Are you sure you want to close this ticket?')) return;
  
  fetch(`/api/ticket/${ticketId}/close`, { 
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    }
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      alert('✅ Ticket closed successfully');
      location.reload();
    } else {
      alert('❌ Error: ' + (data.error || 'Failed to close ticket'));
    }
  })
  .catch(err => {
    console.error('Error:', err);
    alert('❌ Failed to close ticket');
  });
}
