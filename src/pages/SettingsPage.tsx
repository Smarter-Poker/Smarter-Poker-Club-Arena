/**
 * 🎰 CLUB ENGINE — Settings Page
 * App and account settings
 */

import styles from './SettingsPage.module.css';

export default function SettingsPage() {
    return (
        <div className={styles.page}>
            <header className={styles.header}>
                <h1>⚙️ Settings</h1>
            </header>
            <div className={styles.content}>
                <section className={styles.section}>
                    <h2>Account</h2>
                    <div className={styles.settingItem}>
                        <span>Email</span>
                        <span className={styles.settingValue}>player@example.com</span>
                    </div>
                    <div className={styles.settingItem}>
                        <span>Password</span>
                        <button className="btn btn-ghost">Change</button>
                    </div>
                </section>

                <section className={styles.section}>
                    <h2>Preferences</h2>
                    <div className={styles.settingItem}>
                        <span>Theme</span>
                        <select className={styles.select}>
                            <option>Dark</option>
                            <option>Light</option>
                        </select>
                    </div>
                    <div className={styles.settingItem}>
                        <span>Sound Effects</span>
                        <input type="checkbox" defaultChecked />
                    </div>
                    <div className={styles.settingItem}>
                        <span>Notifications</span>
                        <input type="checkbox" defaultChecked />
                    </div>
                </section>

                <section className={styles.section}>
                    <h2>Table Settings</h2>
                    <div className={styles.settingItem}>
                        <span>Four-Color Deck</span>
                        <input type="checkbox" />
                    </div>
                    <div className={styles.settingItem}>
                        <span>Auto Muck Losing Hands</span>
                        <input type="checkbox" defaultChecked />
                    </div>
                </section>
            </div>
        </div>
    );
}
