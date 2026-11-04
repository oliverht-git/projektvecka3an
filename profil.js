const displayname = () => {
    const name = localStorage.getItem('username');
    document.getElementById('display-name').textContent = name;
};