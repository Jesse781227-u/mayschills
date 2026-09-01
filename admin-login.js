(() => {
    const login = document.getElementById('login-panel');
    const password = document.getElementById('password');
    if (!login || !password) return;

    const style = document.createElement('style');
    style.textContent = '.login{text-align:center}.login-logo{display:block;width:96px;height:96px;margin:0 auto 18px;object-fit:cover;border-radius:20px;box-shadow:0 8px 20px #20452b18}.login form{text-align:left}.password-wrap{position:relative}.password-wrap .input{padding-right:48px}.password-toggle{position:absolute;right:8px;top:7px;width:38px!important;height:38px;padding:0;border:0;background:transparent;color:var(--muted);font-size:18px;cursor:pointer}';
    document.head.appendChild(style);

    const logo = document.createElement('img');
    logo.className = 'login-logo';
    logo.src = 'https://i.ibb.co/hJNHPS8T/IMG-20251112-WA0082.jpg';
    logo.alt = "May's Chills logo";
    login.prepend(logo);

    const wrapper = document.createElement('div');
    wrapper.className = 'password-wrap';
    password.parentNode.insertBefore(wrapper, password);
    wrapper.appendChild(password);

    const toggle = document.createElement('button');
    toggle.className = 'password-toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-label', 'Show password');
    toggle.title = 'Show password';
    toggle.textContent = '\u{1F441}';
    wrapper.appendChild(toggle);
    toggle.addEventListener('click', () => {
        const visible = password.type === 'text';
        password.type = visible ? 'password' : 'text';
        toggle.setAttribute('aria-label', visible ? 'Show password' : 'Hide password');
        toggle.title = visible ? 'Show password' : 'Hide password';
    });
})();
