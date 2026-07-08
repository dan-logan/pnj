# Pegs and Jokers

A digital implementation of the classic Pegs and Jokers board game.

## Install as an app (PWA)

The game is a Progressive Web App, so you can install it to your home screen and
play full-screen and offline — no browser chrome, works with no connection.

- **Android / Chrome / Edge:** open the site and tap the **Install** banner (or
  the browser's ⋮ menu → *Install app* / *Add to Home screen*).
- **iPhone / iPad (Safari):** tap the **Share** button, then **Add to Home
  Screen**.

Once installed it launches from its own icon like a native app.

## Save & resume

Your game is saved to the device after every move. If a tab gets evicted (a
phone call, switching apps, or just closing the tab), you'll be offered
**Resume game?** the next time you open it.

## Deploy to GitHub Pages (Free)

1. Create a new GitHub repository
2. Unzip and push these files to the `main` branch
3. Go to your repo → **Settings** → **Pages**
4. Under "Build and deployment", set Source to **GitHub Actions**
5. Push any change (or re-run the workflow manually)
6. Your site will be live at `https://yourusername.github.io/your-repo-name/`

The included GitHub Action automatically builds and deploys on every push.

## Local Development

```bash
npm install
npm run dev
```

## Build Manually

```bash
npm run build
```

The built files will be in the `dist` folder.
