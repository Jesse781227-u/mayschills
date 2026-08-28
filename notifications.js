(function () {
    const API = () => (window.MAYCHILLS_API_URL || 'https://mayschillsbackend.onrender.com');
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    function keyBytes(value) { const padding = '='.repeat((4 - value.length % 4) % 4); const raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...raw].map(char => char.charCodeAt(0))); }
    async function enable(button, details = {}) {
        if (isIOS && !isStandalone) throw new Error('On iPhone: tap Share → Add to Home Screen, open the new May’s Chills icon, then tap Enable order updates.');
        if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) throw new Error('Push notifications are not supported in this browser.');
        const config = await fetch(API() + '/api/notifications/config', { cache: 'no-store' }).then(response => response.json());
        if (!config.enabled) throw new Error('Order notifications are not configured yet.');
        if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications were not enabled.');
        const registration = await navigator.serviceWorker.register('/service-worker.js');
        const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(config.publicKey) });
        const response = await fetch(API() + '/api/notifications/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription, email: details.email || null, name: details.name || null }) });
        if (!response.ok) throw new Error((await response.json()).error || 'Unable to enable notifications.');
        button.textContent = 'Order updates enabled'; button.disabled = true;
    }
    async function showAfterOrder(details = {}) {
        if ('serviceWorker' in navigator && 'PushManager' in window) {
            const registration = await navigator.serviceWorker.getRegistration('/');
            if (registration && await registration.pushManager.getSubscription()) return;
        }
        const prompt = document.createElement('div'); prompt.style.cssText = 'position:fixed;z-index:99999;left:16px;right:16px;bottom:16px;max-width:520px;margin:auto;padding:18px;background:white;border:2px solid #159447;border-radius:16px;box-shadow:0 8px 30px #0003;font:14px Arial;color:#17231c';
        const instructions = isIOS && !isStandalone ? 'On iPhone: use your browser’s Share menu → Add to Home Screen, open the new May’s Chills icon, then enable order updates there.' : 'Allow notifications to receive payment and order-status updates on this device.';
        prompt.innerHTML = `<strong style="font-size:17px;color:#159447">Track your order</strong><p style="line-height:1.45">${instructions}</p><button id="mc-enable-push" style="border:0;border-radius:9px;padding:10px 14px;background:#159447;color:white;font-weight:700">${isIOS && !isStandalone ? 'I added it — enable updates' : 'Enable order updates'}</button><button id="mc-close-push" style="float:right;border:0;background:transparent;color:#718079;padding:10px">Not now</button><span id="mc-push-error" style="display:block;color:#b52d2d;margin-top:8px"></span>`;
        document.body.appendChild(prompt);
        prompt.querySelector('#mc-close-push').onclick = () => prompt.remove();
        prompt.querySelector('#mc-enable-push').onclick = async event => { const error = prompt.querySelector('#mc-push-error'); try { await enable(event.currentTarget, details); setTimeout(() => prompt.remove(), 1200); } catch (reason) { error.textContent = reason.message; } };
    }
    window.MayChillsNotifications = { enable, showAfterOrder };
})();
