(function () {
    const API = () => (window.MAYCHILLS_API_URL || 'https://mayschillsbackend.onrender.com');
    function keyBytes(value) { const padding = '='.repeat((4 - value.length % 4) % 4); const raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...raw].map(char => char.charCodeAt(0))); }
    async function enable(button, details = {}) {
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
    window.MayChillsNotifications = { enable };
})();
