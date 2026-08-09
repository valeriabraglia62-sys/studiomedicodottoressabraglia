// menu.js - Funzionalità per il menu a tendina

document.addEventListener('DOMContentLoaded', function() {
    setupMobileMenu();
});

// Configurazione del menu a tendina per dispositivi mobili
function setupMobileMenu() {
    const menuToggle = document.getElementById('menu-toggle');
    const mainNav = document.getElementById('main-nav');
    
    if (menuToggle && mainNav) {
        menuToggle.addEventListener('click', function() {
            toggleMenu();
        });
        
        // Chiudi il menu quando si clicca su un link
        const menuLinks = mainNav.querySelectorAll('a');
        menuLinks.forEach(link => {
            link.addEventListener('click', function() {
                if (window.innerWidth < 768) {
                    mainNav.classList.remove('show');
                }
            });
        });
        
        // Chiudi il menu quando si ridimensiona la finestra
        window.addEventListener('resize', function() {
            if (window.innerWidth >= 768) {
                mainNav.classList.remove('show');
            }
        });
    }
}

// Funzione per mostrare/nascondere il menu
function toggleMenu() {
    const mainNav = document.getElementById('main-nav');
    if (mainNav) {
        mainNav.classList.toggle('show');
    }
}
