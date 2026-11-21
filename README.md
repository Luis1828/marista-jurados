# Panel de Jurados — Festival Intercolegial Marista

Aplicación web responsive para iPhone/iPad y escritorio. El frontend se publica en **GitHub Pages** y la autenticación, base de datos, almacenamiento privado y validación de permisos funcionan en **Supabase**.

> **Importante:** GitHub Pages sólo aloja archivos estáticos. No puede proteger una base de datos ni validar roles por sí mismo. Por eso este proyecto usa Supabase Auth + PostgreSQL con RLS + Storage privado + Edge Functions. La clave `publishable/anon` del frontend es pública por diseño; la clave `secret/service_role` nunca debe copiarse a `config.js`, al repositorio ni al navegador.

## Funcionalidades incluidas

- Login por usuario y contraseña, sin registro público ni verificación por correo. El sistema convierte internamente el nombre de usuario en un correo técnico reservado de Supabase Auth; los jurados no necesitan conocerlo.
- Clasificación de bandas ordenada por promedio de los criterios activos. Los tres primeros puestos se identifican con oro, plata y bronce.
- Creación de banda en cuatro pasos: fotografía, nombre, calificación de estrellas y notas opcionales.
- Edición de nombre, foto, puntuaciones y comentarios.
- Gráfico radar tipo PES, con seis criterios iniciales editables y posibilidad de añadir, desactivar y reordenar criterios.
- Ficha de banda con valores numéricos, radar y observaciones.
- Módulo de eliminación separado que solicita usuario y contraseña y vuelve a verificar la contraseña con Supabase Auth antes de borrar.
- Administrador: creación/eliminación de cuentas de jurados, cambio de contraseñas, habilitación/deshabilitación de accesos y vista de las bandas creadas por cada jurado. No puede crear, editar ni eliminar bandas ni cambiar sus puntuaciones.
- Registro de auditoría con cambios de bandas, cuentas, acceso y criterios. Verde = creado, amarillo = editado/administrado y rojo = eliminado.
- Ceremonia animada del podio, con revelación de tercer, segundo y primer lugar en aproximadamente 10 segundos.
- Fotos privadas en Supabase Storage, servidas mediante URLs firmadas temporales.

## Arquitectura y permisos

| Recurso | Jurado | Administrador |
|---|---|---|
| Ver la clasificación y detalles de bandas | Sí | Sí |
| Crear y editar bandas | Sí | No |
| Cambiar una fotografía | Sí | No |
| Eliminar bandas | Sí, con revalidación de contraseña | No |
| Ver registro de actividad | Sí | Sí |
| Ver usuarios y bandas creadas por cada uno | No | Sí |
| Crear/eliminar usuarios, cambiar contraseñas y accesos | No | Sí |
| Configurar criterios de calificación | No | Sí |

Las restricciones no dependen sólo de la interfaz. La base de datos no ofrece permisos directos de escritura en bandas/puntuaciones; la operación se realiza mediante `save_band()`, que vuelve a comprobar que la sesión corresponde a un jurado activo. La Edge Function de eliminación vuelve a validar la contraseña. Las operaciones de administración se ejecutan en Edge Functions con credenciales privadas del servidor.

## 1. Crear el proyecto Supabase

1. Entra en [Supabase](https://supabase.com/) y crea un proyecto nuevo.
2. Elige una región cercana a Bolivia/Sudamérica si está disponible.
3. Guarda la contraseña de la base de datos en un lugar privado.
4. En el bloque **Data access** de esta pantalla, selecciona:
   - **Enable Data API:** activado (la web usa el cliente oficial de Supabase).
   - **Grant API access to new tables automatically:** desactivado. La migración concede permisos explícitos sólo a los objetos que necesita la web.
   - **Enable RLS on new tables automatically:** activado. La migración también habilita RLS explícitamente en sus tablas.
5. En **Region**, elige la región específica **South America (São Paulo)** (`sa-east-1`) mediante **Need a specific region?** si está disponible. La opción general **Americas** puede desplegar en North Virginia, no necesariamente en Sudamérica.
6. En el panel del proyecto, abre **Project Settings → API** (en el panel nuevo puede aparecer como **API Keys**).
7. Copia el **Project URL** y la clave **Publishable** o la clave heredada **anon/public**. No copies la clave **Secret** ni `service_role` para el frontend.

## 2. Crear la base de datos y las reglas de seguridad

### Opción recomendada: Supabase CLI desde Windows

Abre PowerShell dentro de la carpeta `marista-jurados`.

1. Comprueba que tienes Node.js instalado.
2. Inicia sesión en Supabase CLI:

```powershell
npx supabase login
```

3. Vincula el proyecto. El identificador está en la URL del proyecto o en Project Settings:

```powershell
npx supabase link --project-ref TU_PROJECT_REF
```

4. Aplica la migración SQL incluida:

```powershell
npx supabase db push
```

El archivo de migración está en `supabase/migrations/202611210001_initial_schema.sql`. Este paso crea tablas, seis criterios iniciales, políticas RLS, el bucket privado de fotos, auditoría y la función segura de guardado.

### Alternativa: SQL Editor

También puedes abrir **SQL Editor → New query**, copiar el contenido completo de `supabase/migrations/202611210001_initial_schema.sql` y ejecutarlo una sola vez. No ejecutes ambos métodos sobre la misma migración a menos que sepas reconciliar el historial de migraciones. Aunque elijas SQL Editor, luego necesitarás `npx supabase login` y `npx supabase link --project-ref TU_PROJECT_REF` para desplegar las Edge Functions.

## 3. Crear la primera cuenta administradora

El proyecto no trae usuarios ni contraseñas predefinidas. En **Authentication → Settings → User Signups**, desactiva **Allow new users to sign up**. Aunque la base de datos también bloquea a cualquier cuenta sin perfil, es mejor desactivar el registro público.

1. En Supabase abre **Authentication → Users → Add user**.
2. Crea el usuario inicial con estos datos:
   - Email técnico: `admin@login.marista-festival.invalid`
   - Contraseña: elige una contraseña fuerte de al menos 10 caracteres.
   - Marca la cuenta como confirmada / **Auto Confirm User**, si aparece esa opción.
3. Abre **SQL Editor** y ejecuta este bloque para crear el perfil administrador:

```sql
insert into public.user_profiles (id, username, role, is_active)
select id, 'admin', 'admin', true
from auth.users
where email = 'admin@login.marista-festival.invalid'
on conflict (id) do update
set username = excluded.username, role = 'admin', is_active = true;
```

4. Comprueba que aparece exactamente una cuenta:

```sql
select username, role, is_active
from public.user_profiles
where username = 'admin';
```

Los perfiles no se crean automáticamente por registrar un usuario en Auth. Sólo el administrador y la función administrativa de alta pueden aprovisionarlos. Así, un registro público accidental no obtiene permisos en la aplicación.

**No compartas el correo técnico con los jurados.** Ellos iniciarán sesión escribiendo solamente `admin` o su nombre de usuario asignado y la contraseña.

## 4. Desplegar las funciones seguras del servidor

Desde PowerShell, en la raíz del proyecto y con el proyecto vinculado:

```powershell
npx supabase functions deploy admin-users
npx supabase functions deploy delete-band
```

La configuración `supabase/config.toml` exige JWT válido para ambas funciones. En el servidor, las funciones vuelven a comprobar la identidad, el rol y el estado activo de la cuenta. La eliminación de una banda registra su fotografía, notas y puntuaciones y ejecuta el log + borrado en una sola transacción de base de datos.

Supabase inyecta las credenciales de servidor en el entorno de Edge Functions. **No las agregues a `config.js`.** Si tu proyecto no expone las variables heredadas, el código también contempla las variables nombradas `SUPABASE_PUBLISHABLE_KEYS` y `SUPABASE_SECRET_KEYS` de Supabase.

## 5. Conectar el frontend con Supabase

Abre `config.js` (está en la raíz) y cambia únicamente estos dos valores:

```js
export const SUPABASE_URL = "https://TU-PROJECT-REF.supabase.co";
export const SUPABASE_ANON_KEY = "PEGA_AQUI_TU_PUBLISHABLE_O_ANON_KEY";
```

Pega tu Project URL y tu clave **Publishable/anon**. Guarda el archivo.

**Nunca pegues aquí:** `service_role`, `secret key`, contraseña de la base de datos, token de acceso personal ni contraseña de usuario.

## 6. Publicar el frontend

### Recomendado para el uso real: Cloudflare Pages conectado a GitHub

**Aviso importante:** la documentación oficial de GitHub indica que GitHub Pages no debería utilizarse para transacciones sensibles como enviar contraseñas. Como este panel incluye inicio de sesión, recomiendo conservar el código en GitHub pero publicar la web real en Cloudflare Pages. La autenticación y la base de datos seguirán en Supabase; Cloudflare sólo alojará los archivos estáticos.

1. Crea un repositorio en GitHub, por ejemplo `marista-jurados`, y sube el contenido de esta carpeta al nivel raíz. `index.html`, `app.js`, `styles.css` y `config.js` deben quedar directamente en la raíz.
2. Haz commit y push a la rama `main`.
3. Entra en [Cloudflare](https://dash.cloudflare.com/) y abre **Workers & Pages → Create application → Pages → Connect to Git**.
4. Autoriza la conexión con GitHub y selecciona el repositorio `marista-jurados`.
5. En la configuración, selecciona la rama de producción `main`, deja el directorio raíz vacío (o `/`) y configura **Build command** como `exit 0` y **Build output directory** como `.`.
6. Guarda y despliega. Cloudflare te asignará una URL HTTPS; cada push a `main` publicará los cambios.

Cloudflare Pages admite repositorios GitHub y sitios estáticos sin framework, por lo que no hace falta compilar este proyecto. Consulta [Git integration](https://developers.cloudflare.com/pages/get-started/git-integration/) y [Static HTML](https://developers.cloudflare.com/pages/framework-guides/deploy-anything/).

### Alternativa solicitada: GitHub Pages

Puedes publicar desde **Settings → Pages → Build and deployment → Deploy from a branch**, eligiendo `main` y `/(root)`. GitHub Pages necesita `index.html` en la raíz y publica cada cambio de la rama seleccionada. Sin embargo, por el aviso anterior no recomiendo utilizar esta alternativa para procesar las contraseñas reales de los jurados.

Ten presente que GitHub Pages es público en Internet incluso si el repositorio es privado (cuando el plan permite repositorios privados). En GitHub Free, Pages requiere que el repositorio sea público. No subas datos del festival, usuarios, contraseñas ni claves secretas al repositorio. La clave publishable/anon es pública por diseño; las políticas RLS y las funciones del servidor protegen la base de datos.

## 7. Crear las cuentas de los jurados

Inicia sesión como `admin`. Abre **Usuarios → Crear usuario**. El nombre de usuario admite de 3 a 24 caracteres: letras sin tilde, números, punto, guion y guion bajo. La contraseña inicial debe tener al menos 10 caracteres.

El administrador puede cambiar la contraseña, habilitar/deshabilitar el acceso o eliminar una cuenta. No existe registro público. Las contraseñas no se muestran ni se guardan en el registro de auditoría.

## 8. Configurar los criterios antes de evaluar

Como todavía no se conocen los nombres definitivos, se crean seis ejes temporales llamados `1`, `2`, `3`, `4`, `5` y `6`. El administrador debe entrar a **Criterios** y renombrarlos según el reglamento del festival.

Se pueden añadir criterios, desactivarlos y cambiar el orden. Deben quedar al menos tres activos. Cada criterio utiliza una escala fija de 1 a 5 estrellas.

**Recomendación:** configura los criterios antes de registrar bandas. Si añades criterios después de haber puntuado bandas, las bandas anteriores no tendrán automáticamente una nota para el criterio nuevo; habrá que editarlas y completar esa calificación antes de guardar.

## 9. Uso desde iPhone / Safari

1. Abre la URL de GitHub Pages en Safari.
2. Inicia sesión con usuario y contraseña.
3. Al crear o cambiar una foto, Safari solicitará permiso de cámara. Pulsa **Permitir**.
4. Si se deniega, entra a la configuración del sitio desde el botón **aA** de Safari, permite Cámara y vuelve a intentar. Como alternativa, el selector del dispositivo permite elegir una foto.
5. Puedes usar **Compartir → Añadir a pantalla de inicio** para tener un acceso directo como si fuera una app.

La aplicación usa `getUserMedia()` y `playsinline`, y presenta una alternativa de selección de imagen si el navegador no permite abrir la cámara directamente.

## 10. Prueba obligatoria antes del festival

Realiza esta prueba con una cuenta de jurado de prueba y otra de administrador:

1. El jurado crea una banda y completa todas sus calificaciones.
2. Comprueba que aparece en la clasificación y en el registro de auditoría.
3. El jurado edita nombre, comentarios y puntuación.
4. El administrador confirma que puede verla, pero no ve botones para editarla ni crear bandas.
5. El administrador cambia la contraseña y deshabilita el acceso de ese jurado. Comprueba que la cuenta ya no puede consultar datos protegidos.
6. Vuelve a habilitar la cuenta y prueba la eliminación de una banda: contraseña correcta debe permitirla; contraseña incorrecta no debe eliminar nada.
7. Comprueba que el evento de eliminación aparece en rojo en la auditoría.
8. Prueba el sitio desde al menos un iPhone real conectado por HTTPS y concede el permiso de cámara.

## Notas y límites operativos

- La clasificación utiliza el promedio aritmético de los criterios activos; los empates se ordenan por nombre de banda. La posición 1, 2 y 3 se utiliza para oro, plata y bronce.
- La ceremonia de premiación revela tercero, segundo y primero en un intervalo aproximado de 10 segundos. Es una presentación visual; no modifica las puntuaciones.
- El registro de auditoría muestra los últimos 150 eventos en la interfaz; los registros completos permanecen en la tabla `audit_logs`.
- Las fotos se almacenan en un bucket privado. La app crea enlaces firmados temporales al iniciar/actualizar la vista.
- La aplicación necesita conexión a Internet durante el uso. No está diseñada para puntuar sin conexión.
- Las cuentas se comparten entre los dispositivos de los jurados; no compartas una misma cuenta si necesitas identificar quién realizó cada cambio.
- Antes de un evento real, activa MFA para las cuentas administradoras en Supabase si la política de seguridad del proyecto lo permite y guarda una copia de seguridad de la base de datos.

## Estructura del proyecto

```text
marista-jurados/
├── index.html
├── app.js
├── styles.css
├── config.js
├── config.example.js
├── assets/
│   └── favicon.svg
└── supabase/
    ├── config.toml
    ├── migrations/
    │   └── 202611210001_initial_schema.sql
    └── functions/
        ├── _shared/common.ts
        ├── admin-users/index.ts
        └── delete-band/index.ts
```
