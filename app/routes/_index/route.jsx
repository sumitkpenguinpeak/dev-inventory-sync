import { redirect, Form, useActionData, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";
import styles from "./styles.module.css";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export const action = async ({ request }) => {
  const errors = loginErrorMessage(await login(request));

  return { errors };
};

export default function App() {
  const { showForm } = useLoaderData();
  const actionData = useActionData();
  const errors = actionData?.errors;

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Dev Inventory Sync</h1>
        <p className={styles.text}>
          Apna Shopify store na products ane inventory ek jagya e juo ane manage karo.
        </p>
        {showForm && (
          <Form className={styles.form} method="post">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>{errors?.shop ?? "e.g: my-shop-domain.myshopify.com"}</span>
            </label>
            <button className={styles.button} type="submit">
              Install app
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Easy install</strong>. Store domain nakho ane app install
            karo.
          </li>
          <li>
            <strong>Product listing</strong>. Badha products search ane filter
            sathe juo.
          </li>
          <li>
            <strong>Product details</strong>. Variants, price ane inventory
            ek page par.
          </li>
        </ul>
      </div>
    </div>
  );
}
