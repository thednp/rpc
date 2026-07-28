import "./style.css";
import { setupForm, setupGreeting } from "./hydrate";

setupGreeting(document.querySelector("h1") as HTMLHeadingElement);
setupForm(document.querySelector("form") as HTMLFormElement);
