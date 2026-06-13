document.addEventListener('DOMContentLoaded', function () {
    const year = new Date().getFullYear();
    const el = document.querySelector('.md-copyright');
    if (el) {
        el.innerHTML = `© ${year} Gopher0727's Playground`;
    }
});